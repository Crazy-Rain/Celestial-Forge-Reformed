// ============================================================
//  CELESTIAL FORGE REFORMED  v1.0.0
//  Single-extension replacement for celestial-forge-tracker
//  + celestial-forge-hud. No SimTracker dependency.
//
//  Features:
//   • Forge block parsing (canonical AI state checkpoint)
//   • Narrative XP parsing (all 3 lorebook patterns)
//   • Level-up detection + GAMER flag full support
//   • In-chat <details> state injection after every AI message
//   • Floating HUD panel (draggable)
//   • Manual controls: add/edit/remove perks + flag editing,
//     set CP/corruption/sanity, import/export JSON
//   • Forge block hiding (replaces SimTracker hide feature)
//   • No `export` — ST non-module compatible
// ============================================================

const CFR_MODULE = "celestial-forge-reformed";

const CFR_FLAGS = [
    'PASSIVE','TOGGLEABLE','ALWAYS-ON','SCALING','UNCAPPED',
    'GAMER','META-SCALING','PERMISSION-GATED','SELECTIVE',
    'CORRUPTING','SANITY-TAXING','COMBAT','UTILITY','CRAFTING',
    'MENTAL','PHYSICAL'
];

const CFR_DEFAULTS = {
    enabled:               true,
    cp_per_response:       10,
    threshold_base:        100,
    auto_parse_forge:      true,
    debug_mode:            false,
    inject_details:        true,
    hide_forge_blocks:     true
};

// ST context refs — populated on init
let cfrSettings  = null;
let cfrExtSettings, cfrSaveDebounced, cfrEventSource, cfrEventTypes;

// Singleton tracker instance
let cfrTracker = null;

// Dedup: last processed chat message index
let cfrLastMsgIdx = -1;

// MutationObserver instance
let cfrObserver = null;


// ============================================================
//  TRACKER CLASS
// ============================================================

class CelestialForgeTracker {
    constructor() {
        this.version = "1.0.0";
        this.state   = this.defaultState();
    }

    defaultState() {
        return {
            response_count:    0,
            base_cp:           0,
            bonus_cp:          0,
            total_cp:          0,
            spent_cp:          0,
            available_cp:      0,
            threshold:         100,
            threshold_progress:0,
            corruption:        0,
            sanity:            0,
            acquired_perks:    [],
            pending_perk:      null,
            active_toggles:    [],
            perk_history:      [],
            has_uncapped:      false,
            has_gamer:         false
        };
    }

    // ── CP ────────────────────────────────────────────────────

    calcTotals() {
        this.state.total_cp          = this.state.base_cp + this.state.bonus_cp;
        this.state.spent_cp          = this.state.acquired_perks.reduce((s,p) => s + (p.cost||0), 0);
        this.state.available_cp      = this.state.total_cp - this.state.spent_cp;
        this.state.threshold_progress = this.state.total_cp % (this.state.threshold || 100);
    }

    incrementResponse() {
        this.state.response_count++;
        this.state.base_cp = this.state.response_count * (this.getSetting('cp_per_response') || 10);
        this.calcTotals();
        this.save();
    }

    // Set available CP to an exact value by adjusting bonus_cp
    setAvailableCP(target) {
        this.calcTotals();
        const needed = target - this.state.available_cp;
        this.state.bonus_cp = Math.max(0, this.state.bonus_cp + needed);
        this.calcTotals();
        this.save();
        this.broadcast();
    }

    addBonusCP(amount) {
        this.state.bonus_cp += amount;
        this.calcTotals();
        this.save();
        this.broadcast();
    }

    setCorruption(val) {
        this.state.corruption = Math.min(100, Math.max(0, parseInt(val) || 0));
        this.save();
        this.broadcast();
    }

    setSanity(val) {
        this.state.sanity = Math.min(100, Math.max(0, parseInt(val) || 0));
        this.save();
        this.broadcast();
    }

    // ── PERK MANAGEMENT ──────────────────────────────────────

    makeScaling(data) {
        const base = {
            level:     1,
            maxLevel:  this.state.has_uncapped ? 999 : 10,
            xp:        0,
            xp_needed: 10,
            xp_percent: 0,
            uncapped:  this.state.has_uncapped
        };
        if (data?.scaling && typeof data.scaling === 'object') {
            return {
                level:     data.scaling.level     || base.level,
                maxLevel:  this.state.has_uncapped ? 999 : (data.scaling.maxLevel || base.maxLevel),
                xp:        data.scaling.xp        || 0,
                xp_needed: data.scaling.xp_needed || ((data.scaling.level||1) * 10),
                xp_percent: data.scaling.xp_percent || 0,
                uncapped:  this.state.has_uncapped || data.scaling.uncapped || false
            };
        }
        return base;
    }

    // Build a clean perk object from raw data
    buildPerk(data) {
        const flags = Array.isArray(data.flags)
            ? data.flags.map(f => f.toUpperCase())
            : [];
        const hasScaling = flags.includes('SCALING') || !!data.scaling;
        return {
            name:        (data.name || 'Unknown').trim(),
            cost:        parseInt(data.cost) || 0,
            flags,
            description: data.description || '',
            toggleable:  flags.includes('TOGGLEABLE'),
            active:      data.active !== false,
            scaling:     hasScaling ? this.makeScaling(data) : null,
            acquired_at: data.acquired_at || Date.now(),
            acquired_response: data.acquired_response || this.state.response_count
        };
    }

    addPerk(data) {
        const name = (data.name || '').trim();
        if (!name) return { success: false, reason: 'no_name' };

        // Special flags — order matters
        const flags = Array.isArray(data.flags) ? data.flags.map(f=>f.toUpperCase()) : [];
        if (flags.includes('UNCAPPED') || name.toUpperCase().includes('UNCAPPED')) {
            this.applyUncapped();
        }
        if (flags.includes('GAMER') || flags.includes('META-SCALING')) {
            this.state.has_gamer = true;
        }

        const perk = this.buildPerk(data);
        this.calcTotals();

        if (perk.cost <= this.state.available_cp) {
            this.state.acquired_perks.push(perk);
            this.state.perk_history.push({ action:'acquired', perk:perk.name, cost:perk.cost, ts:Date.now() });
            if (this.state.pending_perk?.name?.toLowerCase() === perk.name.toLowerCase()) {
                this.state.pending_perk = null;
            }
            this.calcTotals();
            this.save();
            this.broadcast();
            this.log(`✅ Perk added: ${perk.name} (${perk.cost} CP)`);
            return { success: true, perk };
        } else {
            this.state.pending_perk = {
                name:      perk.name,
                cost:      perk.cost,
                flags:     perk.flags,
                cp_needed: perk.cost - this.state.available_cp
            };
            this.save();
            this.broadcast();
            this.log(`⏳ Perk pending: ${perk.name} — need ${this.state.pending_perk.cp_needed} more CP`);
            return { success: false, reason: 'insufficient_cp', pending: this.state.pending_perk };
        }
    }

    // Edit an existing perk — handles flag changes, scaling changes
    editPerk(perkName, updates) {
        const idx = this.state.acquired_perks.findIndex(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (idx === -1) return { success: false, reason: 'not_found' };

        const perk  = this.state.acquired_perks[idx];
        const flags = Array.isArray(updates.flags)
            ? updates.flags.map(f => f.toUpperCase())
            : perk.flags;

        // Detect special flag additions
        if (flags.includes('UNCAPPED') && !this.state.has_uncapped) {
            this.applyUncapped();
        }
        if ((flags.includes('GAMER') || flags.includes('META-SCALING')) && !this.state.has_gamer) {
            this.state.has_gamer = true;
        }

        const hasScaling = flags.includes('SCALING') || !!updates.scaling || !!perk.scaling;

        this.state.acquired_perks[idx] = {
            ...perk,
            name:        updates.name        ?? perk.name,
            cost:        parseInt(updates.cost) || perk.cost,
            flags,
            description: updates.description ?? perk.description,
            toggleable:  flags.includes('TOGGLEABLE'),
            active:      updates.active      ?? perk.active,
            scaling:     hasScaling
                ? this.makeScaling({ ...perk, ...updates })
                : null
        };

        // If level/XP overridden directly
        if (hasScaling && this.state.acquired_perks[idx].scaling) {
            if (updates.level !== undefined)
                this.state.acquired_perks[idx].scaling.level = parseInt(updates.level) || 1;
            if (updates.xp !== undefined)
                this.state.acquired_perks[idx].scaling.xp = parseInt(updates.xp) || 0;
            this.recalcScalingPerk(this.state.acquired_perks[idx]);
        }

        this.calcTotals();
        this.save();
        this.broadcast();
        this.log(`✏️ Perk edited: ${perk.name}`);
        return { success: true };
    }

    removePerk(perkName) {
        const before = this.state.acquired_perks.length;
        this.state.acquired_perks = this.state.acquired_perks.filter(p =>
            p.name.toLowerCase() !== perkName.toLowerCase()
        );
        if (this.state.acquired_perks.length === before) return { success: false, reason: 'not_found' };
        this.calcTotals();
        this.save();
        this.broadcast();
        this.log(`🗑️ Perk removed: ${perkName}`);
        return { success: true };
    }

    togglePerk(perkName) {
        const perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk)            return { success: false, reason: 'not_found' };
        if (!perk.toggleable) return { success: false, reason: 'not_toggleable' };

        perk.active = !perk.active;
        if (perk.active) {
            if (!this.state.active_toggles.includes(perk.name))
                this.state.active_toggles.push(perk.name);
        } else {
            this.state.active_toggles = this.state.active_toggles.filter(n =>
                n.toLowerCase() !== perk.name.toLowerCase()
            );
        }
        this.save();
        this.broadcast();
        return { success: true, active: perk.active };
    }

    applyUncapped() {
        this.state.has_uncapped = true;
        for (const p of this.state.acquired_perks) {
            if (p.scaling) {
                p.scaling.maxLevel = 999;
                p.scaling.uncapped = true;
            }
        }
        this.log('⚡ UNCAPPED active — all scaling perks unlimited');
    }

    // ── XP / LEVELS ──────────────────────────────────────────

    recalcScalingPerk(perk) {
        if (!perk.scaling) return;
        perk.scaling.xp_needed = perk.scaling.level * 10;
        perk.scaling.xp_percent = Math.min(100,
            Math.round((perk.scaling.xp / perk.scaling.xp_needed) * 100)
        );
    }

    addXP(perkName, amount) {
        // Find perk — if GAMER active, any perk can receive XP
        let perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return null;

        // If perk doesn't have scaling yet, auto-add it when GAMER is active
        if (!perk.scaling) {
            if (this.state.has_gamer || perk.flags.includes('SCALING')) {
                perk.scaling = this.makeScaling({});
                if (!perk.flags.includes('SCALING')) perk.flags.push('SCALING');
            } else {
                return null; // non-SCALING perk without GAMER — ignore XP
            }
        }

        perk.scaling.xp += amount;
        this.log(`+${amount} XP → ${perk.name} (now ${perk.scaling.xp} XP)`);

        // Level up loop
        while (true) {
            const needed = perk.scaling.level * 10;
            if (perk.scaling.xp < needed) break;
            if (perk.scaling.level >= perk.scaling.maxLevel && !perk.scaling.uncapped) {
                perk.scaling.xp = needed; // cap at max
                break;
            }
            perk.scaling.xp -= needed;
            perk.scaling.level++;
            this.log(`🆙 ${perk.name} leveled up to Lv.${perk.scaling.level}!`);
        }

        this.recalcScalingPerk(perk);
        this.save();
        this.broadcast();
        return perk.scaling;
    }

    setLevel(perkName, level, xp = 0) {
        const perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return null;
        if (!perk.scaling) {
            perk.scaling = this.makeScaling({});
            if (!perk.flags.includes('SCALING')) perk.flags.push('SCALING');
        }
        perk.scaling.level = parseInt(level) || 1;
        perk.scaling.xp    = parseInt(xp)    || 0;
        this.recalcScalingPerk(perk);
        this.save();
        this.broadcast();
        return perk.scaling;
    }

    // ── FORGE BLOCK PARSING ──────────────────────────────────

    parseForgeBlock(text) {
        const m = text.match(/```forge\s*([\s\S]*?)```/);
        if (!m) return null;
        try {
            const data  = JSON.parse(m[1].trim());
            const char  = data.characters?.[0];
            if (!char) return null;
            const stats = char.stats || char;
            return {
                total_cp:      stats.total_cp     || 0,
                available_cp:  stats.available_cp || 0,
                corruption:    stats.corruption   || 0,
                sanity:        stats.sanity       || 0,
                perks:         this.normalizePerks(stats.perks),
                pending_perk:  stats.pending_perk || '',
                pending_cp:    stats.pending_cp   || 0,
                pending_remaining: stats.pending_remaining || 0
            };
        } catch(e) {
            this.log('⚠️ Forge block parse error:', e.message);
            return null;
        }
    }

    normalizePerks(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) return raw.map(p => this.buildPerk(p));
        if (typeof raw === 'string') {
            return raw.split('|').map(part => {
                const m = part.match(/(.+?)\s*\((\d+)\s*CP\)/);
                return m ? this.buildPerk({ name: m[1].trim(), cost: parseInt(m[2]) }) : null;
            }).filter(Boolean);
        }
        return [];
    }

    syncFromForge(parsed) {
        if (!parsed) return;

        // Corruption/sanity — authoritative from block only
        this.state.corruption = parsed.corruption;
        this.state.sanity     = parsed.sanity;

        // Merge perks
        for (const fp of parsed.perks) {
            const existing = this.state.acquired_perks.find(p =>
                p.name.toLowerCase() === fp.name.toLowerCase()
            );
            if (existing) {
                // Update scaling from block if present
                if (fp.scaling && existing.scaling) {
                    Object.assign(existing.scaling, fp.scaling);
                    this.recalcScalingPerk(existing);
                }
                if (fp.active !== undefined) existing.active = fp.active;
            } else {
                this.addPerk(fp);
            }
        }

        // Pending perk from block
        if (parsed.pending_perk) {
            this.state.pending_perk = {
                name:      parsed.pending_perk,
                cost:      parsed.pending_cp,
                cp_needed: parsed.pending_remaining
            };
        }

        this.save();
        this.broadcast();
    }

    // ── NARRATIVE XP PARSING ─────────────────────────────────
    // Matches all three lorebook-specified XP formats:
    //   **PERK NAME** gains X XP from action!
    //   +X XP to **PERK NAME**
    //   **PERK NAME**: +X XP
    // Also detects level-up lines.

    parseNarrativeXP(text) {
        const patterns = [
            // **PERK NAME** gains X XP from ...
            { re: /\*\*([^*]+?)\*\*\s+gains\s+(\d+)\s+XP/gi, ni: 1, xi: 2 },
            // +X XP to **PERK NAME**
            { re: /\+(\d+)\s+XP\s+to\s+\*\*([^*]+?)\*\*/gi, ni: 2, xi: 1 },
            // **PERK NAME**: +X XP
            { re: /\*\*([^*]+?)\*\*:\s*\+(\d+)\s+XP/gi,      ni: 1, xi: 2 }
        ];

        for (const { re, ni, xi } of patterns) {
            for (const m of text.matchAll(re)) {
                const perkName = m[ni].trim();
                const xp       = parseInt(m[xi]);
                this.addXP(perkName, xp);
            }
        }

        // Level-up lines — **PERK** leveled up to Level X  /  PERK is now Level X
        for (const m of text.matchAll(/\*\*([^*]+?)\*\*\s+leveled\s+up\s+to\s+Level\s+(\d+)/gi)) {
            const perk = this.state.acquired_perks.find(p =>
                p.name.toLowerCase() === m[1].trim().toLowerCase()
            );
            if (perk?.scaling) {
                perk.scaling.level = parseInt(m[2]);
                perk.scaling.xp    = 0;
                this.recalcScalingPerk(perk);
                this.log(`🆙 Level-up confirmed: ${perk.name} → Lv.${perk.scaling.level}`);
            }
        }
    }

    // ── INLINE PERK DETECTION ────────────────────────────────
    // Catches:  **PERK NAME** (100 CP) [FLAG1, FLAG2]

    parseInlinePerks(text) {
        for (const m of text.matchAll(/\*\*([A-Z][A-Z\s\-']+?)\*\*\s*\((\d+)\s*CP\).*?\[([^\]]*)\]/g)) {
            const name = m[1].trim();
            const already = this.state.acquired_perks.some(p =>
                p.name.toLowerCase() === name.toLowerCase()
            );
            if (!already) {
                this.addPerk({
                    name,
                    cost:  parseInt(m[2]),
                    flags: m[3].split(/[,\s]+/).map(f=>f.trim()).filter(Boolean)
                });
            }
        }
    }

    // ── MAIN RESPONSE PROCESSOR ──────────────────────────────

    processResponse(text) {
        if (!this.getSetting('enabled')) return;

        // 1. Forge block (canonical state)
        if (this.getSetting('auto_parse_forge')) {
            const parsed = this.parseForgeBlock(text);
            if (parsed) {
                this.syncFromForge(parsed);
                this.log('📦 Forge block synced');
            }
        }

        // 2. Inline perk detection
        this.parseInlinePerks(text);

        // 3. Narrative XP (runs every time — GAMER or SCALING)
        this.parseNarrativeXP(text);

        // 4. CP tick
        this.incrementResponse();
    }

    // ── OUTPUT GENERATION ────────────────────────────────────

    toSimTrackerJSON() {
        this.calcTotals();
        return {
            characters: [{
                characterName:   'Smith',
                currentDateTime: new Date().toLocaleString(),
                bgColor:         '#e94560',
                stats: {
                    total_cp:           this.state.total_cp,
                    available_cp:       this.state.available_cp,
                    spent_cp:           this.state.spent_cp,
                    threshold_progress: this.state.threshold_progress,
                    threshold_max:      this.state.threshold,
                    threshold_percent:  Math.round((this.state.threshold_progress / (this.state.threshold||100)) * 100),
                    corruption:         this.state.corruption,
                    sanity:             this.state.sanity,
                    perk_count:         this.state.acquired_perks.length,
                    perks: this.state.acquired_perks.map(p => ({
                        name:        p.name,
                        cost:        p.cost,
                        flags:       p.flags,
                        flags_str:   p.flags.join(', '),
                        description: p.description,
                        toggleable:  p.toggleable,
                        active:      p.active,
                        has_scaling: !!p.scaling,
                        is_uncapped: p.scaling?.uncapped || false,
                        scaling:     p.scaling ? {
                            level:       p.scaling.level,
                            maxLevel:    p.scaling.maxLevel,
                            xp:          p.scaling.xp,
                            xp_needed:   p.scaling.xp_needed,
                            xp_percent:  p.scaling.xp_percent,
                            uncapped:    p.scaling.uncapped,
                            level_display: p.scaling.uncapped
                                ? `Lv.${p.scaling.level}/∞`
                                : `Lv.${p.scaling.level}/${p.scaling.maxLevel}`,
                            xp_display: `${p.scaling.xp}/${p.scaling.xp_needed} XP`
                        } : null
                    })),
                    pending_perk:      this.state.pending_perk?.name      || '',
                    pending_cp:        this.state.pending_perk?.cost      || 0,
                    pending_remaining: this.state.pending_perk?.cp_needed || 0
                }
            }]
        };
    }

    toContextBlock() {
        this.calcTotals();
        const perks = this.state.acquired_perks.map(p => {
            let s = `- ${p.name} (${p.cost} CP) [${p.flags.join(', ')}]`;
            if (p.scaling) s += ` [Lv.${p.scaling.level}/${p.scaling.uncapped ? '∞' : p.scaling.maxLevel} — ${p.scaling.xp}/${p.scaling.xp_needed} XP]`;
            if (p.toggleable) s += p.active ? ' [ON]' : ' [OFF]';
            return s;
        }).join('\n');

        return `[FORGE STATE]
CP: ${this.state.total_cp} total | ${this.state.available_cp} available | ${this.state.spent_cp} spent
Threshold: ${this.state.threshold_progress}/${this.state.threshold}
Corruption: ${this.state.corruption}/100 | Sanity: ${this.state.sanity}/100
${this.state.has_uncapped ? 'UNCAPPED ACTIVE | ' : ''}${this.state.has_gamer ? 'GAMER ACTIVE' : ''}
PERKS (${this.state.acquired_perks.length}):
${perks || '(none)'}${this.state.pending_perk ? `\nPENDING: ${this.state.pending_perk.name} (${this.state.pending_perk.cost} CP — need ${this.state.pending_perk.cp_needed} more)` : ''}`;
    }

    toForgeInjection() {
        return '```forge\n' + JSON.stringify(this.toSimTrackerJSON(), null, 2) + '\n```';
    }

    // ── PERSISTENCE ──────────────────────────────────────────

    save() {
        try {
            const ctx = SillyTavern.getContext();
            const key = ctx?.chatId
                ? `cfr_${ctx.chatId}`
                : 'cfr_global';
            localStorage.setItem(key, JSON.stringify(this.state));
        } catch(e) { console.warn('[CFR] Save failed:', e); }
    }

    load() {
        try {
            const ctx = SillyTavern.getContext();
            let raw = ctx?.chatId
                ? localStorage.getItem(`cfr_${ctx.chatId}`)
                : null;
            if (!raw) raw = localStorage.getItem('cfr_global');
            if (raw) {
                this.state = { ...this.defaultState(), ...JSON.parse(raw) };
                this.calcTotals();
            }
        } catch(e) { console.warn('[CFR] Load failed:', e); }
        return this.state;
    }

    reset() {
        this.state = this.defaultState();
        this.save();
        this.broadcast();
    }

    exportJSON() {
        return JSON.stringify(this.state, null, 2);
    }

    importJSON(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
            this.state = { ...this.defaultState(), ...parsed };
            this.calcTotals();
            this.save();
            this.broadcast();
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }

    // ── BROADCAST / HELPERS ──────────────────────────────────

    broadcast() {
        const data = this.toSimTrackerJSON();
        window.cfrState = data;
        window.celestialForgeState = data; // legacy compat
        window.dispatchEvent(new CustomEvent('celestial-forge-update', { detail: data }));
        updateTrackerUI();
        updateHUD();
        refreshAllDetails();
    }

    getSetting(key) {
        return cfrSettings?.[key] ?? CFR_DEFAULTS[key];
    }

    log(...args) {
        if (this.getSetting('debug_mode')) console.log('[CFR]', ...args);
    }

    status() {
        return {
            version: this.version,
            enabled: this.getSetting('enabled'),
            perks:   this.state.acquired_perks.length,
            cp:      this.state.total_cp,
            uncapped: this.state.has_uncapped,
            gamer:   this.state.has_gamer
        };
    }
}


// ============================================================
//  SETTINGS DRAWER HTML
// ============================================================

function getCFRSettingsHtml() {
    const flagCheckboxes = CFR_FLAGS.map(f => `
        <label class="cfr-flag-grid-item">
            <input type="checkbox" class="cfr-add-flag" value="${f}" /> ${f}
        </label>`).join('');

    const editFlagCheckboxes = CFR_FLAGS.map(f => `
        <label class="cfr-flag-grid-item">
            <input type="checkbox" class="cfr-edit-flag" value="${f}" /> ${f}
        </label>`).join('');

    return `
<div id="cfr-settings-panel" class="cfr-panel">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>⚒️ Celestial Forge Reformed v1.0</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <!-- STATUS -->
      <div class="cfr-status-section">
        <div class="cfr-stat-row"><span>Total CP:</span>     <span id="cfr-total-cp"   class="cfr-value">0</span></div>
        <div class="cfr-stat-row"><span>Available CP:</span> <span id="cfr-avail-cp"   class="cfr-value">0</span></div>
        <div class="cfr-stat-row"><span>Spent CP:</span>     <span id="cfr-spent-cp"   class="cfr-value">0</span></div>
        <div class="cfr-stat-row"><span>Perks:</span>        <span id="cfr-perk-count" class="cfr-value">0</span></div>

        <div class="cfr-bar-wrap">
          <div class="cfr-bar-label-row"><span>Threshold:</span><span id="cfr-threshold-txt">0/100</span></div>
          <div class="cfr-progress-bar"><div id="cfr-threshold-bar" class="cfr-progress-fill cp" style="width:0%"></div></div>
        </div>
        <div class="cfr-bar-wrap">
          <div class="cfr-bar-label-row"><span>Corruption:</span><span id="cfr-corruption-txt">0/100</span></div>
          <div class="cfr-progress-bar"><div id="cfr-corruption-bar" class="cfr-progress-fill corruption" style="width:0%"></div></div>
        </div>
        <div class="cfr-bar-wrap">
          <div class="cfr-bar-label-row"><span>Sanity:</span><span id="cfr-sanity-txt">0/100</span></div>
          <div class="cfr-progress-bar"><div id="cfr-sanity-bar" class="cfr-progress-fill sanity" style="width:0%"></div></div>
        </div>
      </div>

      <div id="cfr-pending-row" class="cfr-pending"></div>

      <!-- PERK LIST -->
      <div style="margin-top:10px;">
        <div style="font-weight:bold;color:#e94560;margin-bottom:6px;font-size:12px;">📜 ACQUIRED PERKS</div>
        <div id="cfr-perk-list" class="cfr-perk-list"><small>No perks yet</small></div>
      </div>

      <!-- MANUAL CONTROLS -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">🛠 Manual Controls</div>
        <div class="cfr-tabs">
          <div class="cfr-tab active" data-tab="cfr-tab-cp">CP / Stats</div>
          <div class="cfr-tab" data-tab="cfr-tab-add">Add Perk</div>
          <div class="cfr-tab" data-tab="cfr-tab-edit">Edit Perk</div>
          <div class="cfr-tab" data-tab="cfr-tab-remove">Remove</div>
          <div class="cfr-tab" data-tab="cfr-tab-io">Import / Export</div>
        </div>

        <!-- TAB: CP / STATS -->
        <div id="cfr-tab-cp" class="cfr-tab-content active">
          <div class="cfr-input-row">
            <label>Set Available CP:</label>
            <input type="number" id="cfr-set-cp-val" min="0" placeholder="e.g. 500" />
            <input type="button" class="menu_button" id="cfr-btn-set-cp" value="Set" style="width:auto;padding:4px 12px;" />
          </div>
          <div class="cfr-input-row">
            <label>Add Bonus CP:</label>
            <input type="number" id="cfr-bonus-cp-val" min="0" placeholder="e.g. 100" />
            <input type="button" class="menu_button" id="cfr-btn-add-bonus" value="Add" style="width:auto;padding:4px 12px;" />
          </div>
          <div class="cfr-input-row">
            <label>Set Corruption:</label>
            <input type="number" id="cfr-set-corr" min="0" max="100" placeholder="0-100" />
            <input type="button" class="menu_button" id="cfr-btn-set-corr" value="Set" style="width:auto;padding:4px 12px;" />
          </div>
          <div class="cfr-input-row">
            <label>Set Sanity:</label>
            <input type="number" id="cfr-set-san" min="0" max="100" placeholder="0-100" />
            <input type="button" class="menu_button" id="cfr-btn-set-san" value="Set" style="width:auto;padding:4px 12px;" />
          </div>
          <div class="cfr-btn-row" style="margin-top:10px;">
            <input type="button" class="menu_button" id="cfr-btn-reset" value="🔄 Reset All State" />
          </div>
        </div>

        <!-- TAB: ADD PERK -->
        <div id="cfr-tab-add" class="cfr-tab-content">
          <div class="cfr-form-field">
            <label>Perk Name *</label>
            <input type="text" id="cfr-add-name" placeholder="e.g. Iron Synthesis" />
          </div>
          <div class="cfr-form-field">
            <label>Cost (CP)</label>
            <input type="number" id="cfr-add-cost" min="0" value="100" />
          </div>
          <div class="cfr-form-field">
            <label>Description</label>
            <textarea id="cfr-add-desc" placeholder="Perk effect description..."></textarea>
          </div>
          <div class="cfr-form-field">
            <label>Flags</label>
            <div class="cfr-flag-grid" id="cfr-add-flags">${flagCheckboxes}</div>
          </div>
          <div class="cfr-scaling-fields" id="cfr-add-scaling-fields">
            <div class="cfr-form-field">
              <label>Starting Level</label>
              <input type="number" id="cfr-add-level" min="1" value="1" />
            </div>
            <div class="cfr-form-field">
              <label>Starting XP</label>
              <input type="number" id="cfr-add-xp" min="0" value="0" />
            </div>
          </div>
          <div class="cfr-btn-row" style="margin-top:8px;">
            <input type="button" class="menu_button" id="cfr-btn-add-perk" value="➕ Add Perk" />
          </div>
          <div id="cfr-add-status" class="cfr-status-msg"></div>
        </div>

        <!-- TAB: EDIT PERK -->
        <div id="cfr-tab-edit" class="cfr-tab-content">
          <div class="cfr-form-field">
            <label>Select Perk</label>
            <select id="cfr-edit-select"><option value="">— choose perk —</option></select>
          </div>
          <div id="cfr-edit-form" style="display:none;">
            <div class="cfr-form-field">
              <label>Name</label>
              <input type="text" id="cfr-edit-name" />
            </div>
            <div class="cfr-form-field">
              <label>Cost (CP)</label>
              <input type="number" id="cfr-edit-cost" min="0" />
            </div>
            <div class="cfr-form-field">
              <label>Description</label>
              <textarea id="cfr-edit-desc"></textarea>
            </div>
            <div class="cfr-form-field">
              <label>Flags</label>
              <div class="cfr-flag-grid" id="cfr-edit-flags">${editFlagCheckboxes}</div>
            </div>
            <div class="cfr-scaling-fields" id="cfr-edit-scaling-fields">
              <div class="cfr-form-field">
                <label>Level</label>
                <input type="number" id="cfr-edit-level" min="1" value="1" />
              </div>
              <div class="cfr-form-field">
                <label>Current XP</label>
                <input type="number" id="cfr-edit-xp" min="0" value="0" />
              </div>
            </div>
            <div class="cfr-input-row" style="margin-top:6px;">
              <label style="font-size:11px;">Active:</label>
              <input type="checkbox" id="cfr-edit-active" checked />
            </div>
            <div class="cfr-btn-row" style="margin-top:8px;">
              <input type="button" class="menu_button" id="cfr-btn-save-edit" value="💾 Save Changes" />
            </div>
          </div>
          <div id="cfr-edit-status" class="cfr-status-msg"></div>
        </div>

        <!-- TAB: REMOVE -->
        <div id="cfr-tab-remove" class="cfr-tab-content">
          <div class="cfr-form-field">
            <label>Select Perk to Remove</label>
            <select id="cfr-remove-select"><option value="">— choose perk —</option></select>
          </div>
          <div class="cfr-btn-row" style="margin-top:8px;">
            <input type="button" class="menu_button" id="cfr-btn-remove-perk" value="🗑️ Remove Perk" />
          </div>
          <div id="cfr-remove-status" class="cfr-status-msg"></div>
        </div>

        <!-- TAB: IMPORT / EXPORT -->
        <div id="cfr-tab-io" class="cfr-tab-content">
          <textarea id="cfr-io-area" class="cfr-json-area" placeholder="Paste JSON here to import, or click Export…"></textarea>
          <div class="cfr-btn-row" style="margin-top:6px;">
            <input type="button" class="menu_button" id="cfr-btn-export" value="📤 Export" />
            <input type="button" class="menu_button" id="cfr-btn-import" value="📥 Import" />
          </div>
          <div id="cfr-io-status" class="cfr-status-msg"></div>
        </div>
      </div>

      <!-- EXTENSION SETTINGS -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">⚙️ Settings</div>
        <div class="cfr-settings-section">
          <label class="checkbox_label"><input type="checkbox" id="cfr-enabled" /><span>Enable Tracking</span></label>
          <label class="checkbox_label"><input type="checkbox" id="cfr-auto-parse" /><span>Auto-parse forge blocks</span></label>
          <label class="checkbox_label"><input type="checkbox" id="cfr-inject-details" /><span>Inject status into chat messages</span></label>
          <label class="checkbox_label"><input type="checkbox" id="cfr-hide-forge" /><span>Hide forge blocks in chat</span></label>
          <label class="checkbox_label"><input type="checkbox" id="cfr-debug" /><span>Debug mode</span></label>
          <div class="cfr-input-row">
            <label>CP per response:</label>
            <input type="number" id="cfr-cp-per-resp" min="1" max="1000" value="10" style="max-width:70px;" />
          </div>
        </div>
      </div>

    </div>
  </div>
</div>`;
}


// ============================================================
//  TRACKER DRAWER UI UPDATE
// ============================================================

function updateTrackerUI() {
    if (!cfrTracker) return;
    const s = cfrTracker.state;
    cfrTracker.calcTotals();

    $('#cfr-total-cp').text(s.total_cp);
    $('#cfr-avail-cp').text(s.available_cp);
    $('#cfr-spent-cp').text(s.spent_cp);
    $('#cfr-perk-count').text(s.acquired_perks.length);

    const thPct = Math.round((s.threshold_progress / (s.threshold||100)) * 100);
    $('#cfr-threshold-txt').text(`${s.threshold_progress}/${s.threshold}`);
    $('#cfr-threshold-bar').css('width', `${thPct}%`);
    $('#cfr-corruption-txt').text(`${s.corruption}/100`);
    $('#cfr-corruption-bar').css('width', `${s.corruption}%`);
    $('#cfr-sanity-txt').text(`${s.sanity}/100`);
    $('#cfr-sanity-bar').css('width', `${s.sanity}%`);

    const pending = $('#cfr-pending-row');
    if (s.pending_perk) {
        pending.html(`
            <div class="cfr-pending-title">⏳ Pending Perk</div>
            <div class="cfr-pending-name">${s.pending_perk.name}</div>
            <div class="cfr-pending-note">${s.pending_perk.cost} CP — need ${s.pending_perk.cp_needed} more</div>
        `).show();
    } else {
        pending.hide();
    }

    // Perk list
    const list = $('#cfr-perk-list');
    if (!s.acquired_perks.length) {
        list.html('<small>No perks yet</small>');
        return;
    }

    list.html(s.acquired_perks.map((p, idx) => {
        const flags = p.flags.map(f => {
            const cls = f.toLowerCase().replace(/[^a-z]/g,'');
            return `<span class="cfr-flag ${cls}">${f}</span>`;
        }).join('');

        let scaling = '';
        if (p.scaling) {
            const unc  = p.scaling.uncapped;
            const maxS = unc ? '∞' : p.scaling.maxLevel;
            const pct  = p.scaling.xp_percent || 0;
            scaling = `
                <div class="cfr-scaling-bar">
                  <span class="cfr-scaling-label ${unc?'unc':''}">Lv.${p.scaling.level}/${maxS}</span>
                  <div class="cfr-scaling-progress">
                    <div class="cfr-scaling-fill ${unc?'unc':''}" style="width:${pct}%"></div>
                  </div>
                  <span class="cfr-scaling-xp">${p.scaling.xp}/${p.scaling.xp_needed} XP</span>
                </div>`;
        }

        let toggle = '';
        if (p.toggleable) {
            const ic = p.active ? 'fa-toggle-on' : 'fa-toggle-off';
            const co = p.active ? '#2ecc71' : '#666';
            toggle = `<i class="fa-solid ${ic} cfr-perk-toggle" data-perk="${p.name}" style="color:${co};cursor:pointer;font-size:15px;"></i>`;
        }

        const inactive = p.toggleable && !p.active ? 'cfr-inactive' : '';

        return `
        <div class="cfr-perk-item ${inactive}" data-idx="${idx}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="cfr-perk-name">${p.name}</span>
            <span style="display:flex;align-items:center;gap:6px;">
              <span class="cfr-perk-cost">${p.cost} CP</span>
              ${toggle}
            </span>
          </div>
          ${p.description ? `<div class="cfr-perk-desc">${p.description}</div>` : ''}
          <div class="cfr-perk-flags">${flags}</div>
          ${scaling}
        </div>`;
    }).join(''));

    // Toggle clicks
    $('.cfr-perk-toggle').off('click').on('click', function(e) {
        e.stopPropagation();
        cfrTracker.togglePerk($(this).data('perk'));
    });

    // Populate dropdowns for manual controls
    populatePerkDropdowns();
}


// ============================================================
//  HUD FLOATING PANEL
// ============================================================

function injectHUD() {
    $('#cfr-hud').remove();
    $('#cfr-hud-btn').remove();

    $('body').append(`
        <div id="cfr-hud-btn" title="Drag to move · Click to toggle">⚒️</div>
        <div id="cfr-hud" class="hidden">
          <div class="cfr-hud-header">
            <p class="cfr-hud-title">Celestial Forge</p>
            <div class="cfr-hud-sub" id="cfr-hud-sync">waiting…</div>
          </div>
          <div class="cfr-hud-cp">
            <div class="cfr-hud-cp-box">
              <div class="cfr-hud-cp-label">Available CP</div>
              <div class="cfr-hud-cp-val" id="cfr-hud-avail">0</div>
            </div>
            <div class="cfr-hud-cp-box">
              <div class="cfr-hud-cp-label">Total CP</div>
              <div class="cfr-hud-cp-val" id="cfr-hud-total">0</div>
            </div>
            <div class="cfr-hud-cp-box">
              <div class="cfr-hud-cp-label">Spent</div>
              <div class="cfr-hud-cp-val" id="cfr-hud-spent">0</div>
            </div>
          </div>
          <div class="cfr-hud-meters">
            <div class="cfr-hud-meter-row">
              <div class="cfr-hud-meter-label" style="color:#9b59b6">CORRUPTION</div>
              <div class="cfr-hud-meter-track">
                <div class="cfr-hud-meter-fill" id="cfr-hud-corr-fill" style="background:#9b59b6;width:0%"></div>
              </div>
              <div class="cfr-hud-meter-val" id="cfr-hud-corr-val">0%</div>
            </div>
            <div class="cfr-hud-meter-row">
              <div class="cfr-hud-meter-label" style="color:#3498db">SANITY</div>
              <div class="cfr-hud-meter-track">
                <div class="cfr-hud-meter-fill" id="cfr-hud-san-fill" style="background:#3498db;width:0%"></div>
              </div>
              <div class="cfr-hud-meter-val" id="cfr-hud-san-val">0%</div>
            </div>
          </div>
          <div id="cfr-hud-pending"></div>
          <div class="cfr-hud-perks">
            <div class="cfr-hud-perks-title">Acquired Perks (<span id="cfr-hud-perk-count">0</span>)</div>
            <div id="cfr-hud-perk-list"><small style="color:#555;">No perks yet.</small></div>
          </div>
        </div>
    `);

    bindHUDDrag();
}

function bindHUDDrag() {
    const btn = document.getElementById('cfr-hud-btn');
    if (!btn) return;

    let dragging = false, moved = false;
    let sx, sy, il, it;

    const onMove = e => {
        if (!dragging) return;
        moved = true;
        const cx = e.clientX ?? e.touches[0].clientX;
        const cy = e.clientY ?? e.touches[0].clientY;
        btn.style.left  = `${Math.max(0, Math.min(il + cx - sx, window.innerWidth  - btn.offsetWidth))}px`;
        btn.style.top   = `${Math.max(0, Math.min(it + cy - sy, window.innerHeight - btn.offsetHeight))}px`;
        btn.style.right = 'auto';
    };

    const onUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend',  onUp);
    };

    const onDown = e => {
        dragging = true; moved = false;
        sx = e.clientX ?? e.touches[0].clientX;
        sy = e.clientY ?? e.touches[0].clientY;
        const r = btn.getBoundingClientRect();
        il = r.left; it = r.top;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        document.addEventListener('touchmove', onMove, { passive:false });
        document.addEventListener('touchend',  onUp);
    };

    btn.addEventListener('mousedown',  onDown);
    btn.addEventListener('touchstart', onDown, { passive:false });

    btn.addEventListener('click', () => {
        if (moved) return;
        const hud = document.getElementById('cfr-hud');
        hud.classList.toggle('hidden');
        btn.classList.toggle('open', !hud.classList.contains('hidden'));
    });
}

function updateHUD() {
    if (!cfrTracker) return;
    const s = cfrTracker.state;

    $('#cfr-hud-avail').text(s.available_cp);
    $('#cfr-hud-total').text(s.total_cp);
    $('#cfr-hud-spent').text(s.spent_cp);
    $('#cfr-hud-corr-fill').css('width', `${s.corruption}%`);
    $('#cfr-hud-corr-val').text(`${s.corruption}%`);
    $('#cfr-hud-san-fill').css('width', `${s.sanity}%`);
    $('#cfr-hud-san-val').text(`${s.sanity}%`);
    $('#cfr-hud-perk-count').text(s.acquired_perks.length);

    const pending = $('#cfr-hud-pending');
    if (s.pending_perk) {
        pending.html(`
            <div style="margin:8px 15px 0;padding:6px 10px;background:rgba(241,196,15,0.08);border:1px dashed #f1c40f44;border-radius:5px;font-size:11px;">
              <span style="color:#f1c40f;">⏳ Pending: </span>
              <strong>${s.pending_perk.name}</strong>
              <span style="color:#888;"> — ${s.pending_perk.cp_needed} CP needed</span>
            </div>`);
    } else {
        pending.empty();
    }

    const list = $('#cfr-hud-perk-list');
    if (!s.acquired_perks.length) {
        list.html('<small style="color:#555;">No perks yet.</small>');
        return;
    }

    list.html(s.acquired_perks.map(p => {
        const activeClass = p.active ? 'active' : (p.toggleable ? 'inactive' : 'active');
        const flagsHtml   = p.flags.map(f =>
            `<span class="cfr-hud-flag ${p.active ? 'active-flag':''}">${f}</span>`
        ).join('');

        let scaling = '';
        if (p.scaling) {
            const pct = p.scaling.xp_percent || 0;
            const maxL= p.scaling.uncapped ? '∞' : p.scaling.maxLevel;
            scaling = `
                <div style="margin-top:4px;">
                  <div style="display:flex;justify-content:space-between;font-size:10px;color:#2ecc71;margin-bottom:2px;">
                    <span>Lv.${p.scaling.level}/${maxL}</span>
                    <span>${p.scaling.xp}/${p.scaling.xp_needed} XP</span>
                  </div>
                  <div style="height:3px;background:#222;border-radius:2px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:#2ecc71;"></div>
                  </div>
                </div>`;
        }

        return `
            <div class="cfr-hud-perk-card ${activeClass}">
              <div class="cfr-hud-perk-head">
                <span>${p.name}</span>
                <span class="cfr-hud-perk-cost">${p.cost} CP</span>
              </div>
              <div>${flagsHtml}</div>
              ${scaling}
              ${p.description ? `<div class="cfr-hud-perk-desc">${p.description}</div>` : ''}
            </div>`;
    }).join(''));

    const syncEl = document.getElementById('cfr-hud-sync');
    if (syncEl) {
        syncEl.textContent = `● live · ${new Date().toLocaleTimeString()}`;
        syncEl.className   = 'cfr-hud-sync live';
    }
}


// ============================================================
//  IN-CHAT DETAILS INJECTION
// ============================================================

function buildDetailsHTML() {
    if (!cfrTracker) return '';
    const s = cfrTracker.state;
    cfrTracker.calcTotals();

    const corrPct = s.corruption;
    const sanPct  = s.sanity;
    const thPct   = Math.round((s.threshold_progress / (s.threshold||100)) * 100);

    const perksHtml = s.acquired_perks.map(p => {
        const stateClass = p.toggleable ? (p.active ? 'perk-active' : 'perk-off') : 'perk-active';
        const stateLabel = p.toggleable ? (p.active ? '● ON' : '○ OFF') : '';
        const stateStyle = p.active ? 'on' : 'off';
        let scalingInfo  = '';
        if (p.scaling) {
            scalingInfo = `<span class="cfr-detail-perk-level">Lv.${p.scaling.level}/${p.scaling.uncapped?'∞':p.scaling.maxLevel}</span>
                           <span class="cfr-detail-perk-xp">${p.scaling.xp}/${p.scaling.xp_needed} XP</span>`;
        }
        return `
            <div class="cfr-detail-perk ${stateClass}">
              <span class="cfr-detail-perk-name">${p.name}</span>
              <span class="cfr-detail-perk-cost">${p.cost} CP</span>
              ${scalingInfo}
              ${stateLabel ? `<span class="cfr-detail-perk-state ${stateStyle}">${stateLabel}</span>` : ''}
            </div>`;
    }).join('');

    const pendingHtml = s.pending_perk
        ? `<div class="cfr-detail-pending">⏳ Pending: <strong>${s.pending_perk.name}</strong> (${s.pending_perk.cost} CP — ${s.pending_perk.cp_needed} needed)</div>`
        : '';

    const badges = [];
    if (s.has_uncapped) badges.push('<span style="color:#f1c40f;font-size:10px;">⚡ UNCAPPED</span>');
    if (s.has_gamer)    badges.push('<span style="color:#e67e22;font-size:10px;">🎮 GAMER</span>');

    return `
<details class="cfr-details-block">
  <summary>⚒️ Celestial Forge &nbsp;·&nbsp; <span style="color:#ffd700">${s.available_cp} CP</span> available &nbsp;·&nbsp; ${s.acquired_perks.length} perks ${badges.join(' ')}</summary>
  <div class="cfr-details-body">
    <div class="cfr-details-stats">
      <span>Total <span>${s.total_cp}</span></span>
      <span>Spent <span>${s.spent_cp}</span></span>
      <span>Available <span>${s.available_cp}</span></span>
    </div>
    <div class="cfr-details-bar-row">
      <span class="cfr-details-bar-label">Threshold</span>
      <div class="cfr-details-bar-track"><div class="cfr-details-bar-fill cp" style="width:${thPct}%;background:linear-gradient(90deg,#ffd700,#ff8c00)"></div></div>
      <span class="cfr-details-bar-val">${s.threshold_progress}/${s.threshold}</span>
    </div>
    <div class="cfr-details-bar-row">
      <span class="cfr-details-bar-label">Corruption</span>
      <div class="cfr-details-bar-track"><div class="cfr-details-bar-fill" style="width:${corrPct}%;background:linear-gradient(90deg,#9b59b6,#6c3483)"></div></div>
      <span class="cfr-details-bar-val">${corrPct}/100</span>
    </div>
    <div class="cfr-details-bar-row">
      <span class="cfr-details-bar-label">Sanity</span>
      <div class="cfr-details-bar-track"><div class="cfr-details-bar-fill" style="width:${sanPct}%;background:linear-gradient(90deg,#3498db,#1a5276)"></div></div>
      <span class="cfr-details-bar-val">${sanPct}/100</span>
    </div>
    ${s.acquired_perks.length > 0 ? `
    <div class="cfr-details-perks">
      <div class="cfr-details-perks-title">Perks (${s.acquired_perks.length})</div>
      ${perksHtml}
    </div>` : ''}
    ${pendingHtml}
  </div>
</details>`;
}

// Inject a details block at the end of a specific AI message element
function injectDetailsIntoMessage(mesEl) {
    if (!cfrTracker?.getSetting('inject_details')) return;
    if (!mesEl) return;

    const existing = mesEl.querySelector('.cfr-details-block');
    if (existing) {
        existing.outerHTML = buildDetailsHTML();
    } else {
        const textEl = mesEl.querySelector('.mes_text');
        if (textEl) {
            textEl.insertAdjacentHTML('afterend', buildDetailsHTML());
        }
    }
}

// Refresh the details block on the last AI message
function refreshLastDetail() {
    const msgs = document.querySelectorAll('#chat .mes:not(.is_user)');
    if (!msgs.length) return;
    injectDetailsIntoMessage(msgs[msgs.length - 1]);
}

// Refresh all existing injected blocks (after manual edits)
function refreshAllDetails() {
    if (!cfrTracker?.getSetting('inject_details')) return;
    document.querySelectorAll('#chat .mes:not(.is_user)').forEach(el => {
        if (el.querySelector('.cfr-details-block')) {
            injectDetailsIntoMessage(el);
        }
    });
    // Also inject into last message if not already there
    refreshLastDetail();
}


// ============================================================
//  FORGE BLOCK HIDING
// ============================================================

function hideForgeBlocks() {
    if (!cfrTracker?.getSetting('hide_forge_blocks')) return;
    // Target <pre> elements whose contained <code> has language-forge class,
    // or whose text content starts with a forge JSON structure
    document.querySelectorAll('#chat pre').forEach(pre => {
        const code = pre.querySelector('code');
        if (!code) return;
        const isForge = code.classList.contains('language-forge') ||
                        code.textContent.trim().startsWith('```forge') ||
                        pre.previousSibling?.textContent?.includes('```forge');
        // Also check if the raw pre text contains forge block markers
        if (isForge || pre.textContent.includes('"characterName"') && pre.textContent.includes('"stats"')) {
            pre.classList.add('cfr-forge-hidden');
        }
    });

    // Also target code blocks by checking parent structure
    document.querySelectorAll('#chat code.language-forge').forEach(el => {
        const pre = el.closest('pre');
        if (pre) pre.classList.add('cfr-forge-hidden');
    });
}


// ============================================================
//  MANUAL CONTROLS — EVENT BINDING
// ============================================================

function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className   = `cfr-status-msg ${type}`;
    setTimeout(() => { el.className = 'cfr-status-msg'; }, 3000);
}

function populatePerkDropdowns() {
    if (!cfrTracker) return;
    const perks   = cfrTracker.state.acquired_perks;
    const options = perks.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
    const placeholder = '<option value="">— choose perk —</option>';

    $('#cfr-edit-select').html(placeholder + options);
    $('#cfr-remove-select').html(placeholder + options);
}

function bindManualControls() {
    // ── TABS ──
    $(document).on('click', '.cfr-tab', function() {
        const target = $(this).data('tab');
        $('.cfr-tab').removeClass('active');
        $('.cfr-tab-content').removeClass('active');
        $(this).addClass('active');
        $(`#${target}`).addClass('active');
    });

    // ── CP / STATS TAB ──
    $('#cfr-btn-set-cp').on('click', () => {
        const val = parseInt($('#cfr-set-cp-val').val());
        if (isNaN(val) || val < 0) return;
        cfrTracker.setAvailableCP(val);
        $('#cfr-set-cp-val').val('');
    });

    $('#cfr-btn-add-bonus').on('click', () => {
        const val = parseInt($('#cfr-bonus-cp-val').val()) || 0;
        if (val <= 0) return;
        cfrTracker.addBonusCP(val);
        $('#cfr-bonus-cp-val').val('');
    });

    $('#cfr-btn-set-corr').on('click', () => {
        cfrTracker.setCorruption($('#cfr-set-corr').val());
        $('#cfr-set-corr').val('');
    });

    $('#cfr-btn-set-san').on('click', () => {
        cfrTracker.setSanity($('#cfr-set-san').val());
        $('#cfr-set-san').val('');
    });

    $('#cfr-btn-reset').on('click', () => {
        if (confirm('Reset ALL Celestial Forge progress? This cannot be undone.')) {
            cfrTracker.reset();
        }
    });

    // ── ADD PERK TAB ──
    // Show/hide scaling fields when SCALING flag is toggled
    $(document).on('change', '#cfr-add-flags .cfr-add-flag', function() {
        const hasScaling = $('#cfr-add-flags input[value="SCALING"]').prop('checked');
        $('#cfr-add-scaling-fields').toggleClass('visible', hasScaling);
    });

    $('#cfr-btn-add-perk').on('click', () => {
        const name = $('#cfr-add-name').val().trim();
        if (!name) { showStatus('cfr-add-status', '⚠️ Name required', 'err'); return; }

        const flags = [];
        $('#cfr-add-flags .cfr-add-flag:checked').each((_, el) => flags.push(el.value));

        const data = {
            name,
            cost:        parseInt($('#cfr-add-cost').val()) || 0,
            description: $('#cfr-add-desc').val().trim(),
            flags,
            scaling:     flags.includes('SCALING') ? {
                level:    parseInt($('#cfr-add-level').val()) || 1,
                xp:       parseInt($('#cfr-add-xp').val())   || 0,
                maxLevel: cfrTracker.state.has_uncapped ? 999 : 10,
                uncapped: cfrTracker.state.has_uncapped
            } : null
        };

        const result = cfrTracker.addPerk(data);
        if (result.success) {
            showStatus('cfr-add-status', `✅ ${name} added!`, 'ok');
            $('#cfr-add-name, #cfr-add-desc').val('');
            $('#cfr-add-cost').val('100');
            $('#cfr-add-flags .cfr-add-flag').prop('checked', false);
            $('#cfr-add-scaling-fields').removeClass('visible');
        } else if (result.reason === 'insufficient_cp') {
            showStatus('cfr-add-status', `⏳ Added as pending (${result.pending.cp_needed} CP short)`, 'ok');
        } else {
            showStatus('cfr-add-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    // ── EDIT PERK TAB ──
    $('#cfr-edit-select').on('change', function() {
        const name = $(this).val();
        if (!name) { $('#cfr-edit-form').hide(); return; }

        const perk = cfrTracker.state.acquired_perks.find(p => p.name === name);
        if (!perk) return;

        $('#cfr-edit-name').val(perk.name);
        $('#cfr-edit-cost').val(perk.cost);
        $('#cfr-edit-desc').val(perk.description);
        $('#cfr-edit-active').prop('checked', perk.active);

        // Set flag checkboxes
        $('#cfr-edit-flags .cfr-edit-flag').each(function() {
            $(this).prop('checked', perk.flags.includes(this.value));
        });

        // Scaling fields
        const hasScaling = perk.flags.includes('SCALING') || !!perk.scaling;
        $('#cfr-edit-scaling-fields').toggleClass('visible', hasScaling);
        if (perk.scaling) {
            $('#cfr-edit-level').val(perk.scaling.level);
            $('#cfr-edit-xp').val(perk.scaling.xp);
        }

        $('#cfr-edit-form').show();
    });

    // Show/hide scaling on flag toggle
    $(document).on('change', '#cfr-edit-flags .cfr-edit-flag', function() {
        const hasScaling = $('#cfr-edit-flags input[value="SCALING"]').prop('checked');
        $('#cfr-edit-scaling-fields').toggleClass('visible', hasScaling);
    });

    $('#cfr-btn-save-edit').on('click', () => {
        const original = $('#cfr-edit-select').val();
        if (!original) { showStatus('cfr-edit-status', '⚠️ Select a perk first', 'err'); return; }

        const flags = [];
        $('#cfr-edit-flags .cfr-edit-flag:checked').each((_, el) => flags.push(el.value));

        const hasScaling = flags.includes('SCALING');
        const updates = {
            name:        $('#cfr-edit-name').val().trim() || original,
            cost:        parseInt($('#cfr-edit-cost').val()) || 0,
            description: $('#cfr-edit-desc').val().trim(),
            flags,
            active:      $('#cfr-edit-active').prop('checked'),
            level:       hasScaling ? parseInt($('#cfr-edit-level').val()) || 1  : undefined,
            xp:          hasScaling ? parseInt($('#cfr-edit-xp').val())   || 0  : undefined
        };

        const result = cfrTracker.editPerk(original, updates);
        if (result.success) {
            showStatus('cfr-edit-status', '✅ Saved', 'ok');
            $('#cfr-edit-select').val('').trigger('change');
        } else {
            showStatus('cfr-edit-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    // ── REMOVE TAB ──
    $('#cfr-btn-remove-perk').on('click', () => {
        const name = $('#cfr-remove-select').val();
        if (!name) { showStatus('cfr-remove-status', '⚠️ Select a perk first', 'err'); return; }
        if (!confirm(`Remove "${name}"? This cannot be undone.`)) return;

        const result = cfrTracker.removePerk(name);
        showStatus('cfr-remove-status', result.success ? `✅ ${name} removed` : `⚠️ ${result.reason}`,
            result.success ? 'ok' : 'err');
    });

    // ── IMPORT / EXPORT TAB ──
    $('#cfr-btn-export').on('click', () => {
        $('#cfr-io-area').val(cfrTracker.exportJSON());
        showStatus('cfr-io-status', '✅ State exported to text area', 'ok');
    });

    $('#cfr-btn-import').on('click', () => {
        const raw = $('#cfr-io-area').val().trim();
        if (!raw) { showStatus('cfr-io-status', '⚠️ Paste JSON first', 'err'); return; }
        if (!confirm('Overwrite current state with imported data?')) return;
        const result = cfrTracker.importJSON(raw);
        showStatus('cfr-io-status',
            result.success ? '✅ State imported successfully' : `⚠️ Parse error: ${result.error}`,
            result.success ? 'ok' : 'err');
    });
}

function bindExtensionSettings() {
    $('#cfr-enabled').on('change', function() {
        cfrSettings.enabled = $(this).prop('checked');
        cfrSaveDebounced();
    });
    $('#cfr-auto-parse').on('change', function() {
        cfrSettings.auto_parse_forge = $(this).prop('checked');
        cfrSaveDebounced();
    });
    $('#cfr-inject-details').on('change', function() {
        cfrSettings.inject_details = $(this).prop('checked');
        cfrSaveDebounced();
        refreshAllDetails();
    });
    $('#cfr-hide-forge').on('change', function() {
        cfrSettings.hide_forge_blocks = $(this).prop('checked');
        cfrSaveDebounced();
        hideForgeBlocks();
    });
    $('#cfr-debug').on('change', function() {
        cfrSettings.debug_mode = $(this).prop('checked');
        cfrSaveDebounced();
    });
    $('#cfr-cp-per-resp').on('change', function() {
        cfrSettings.cp_per_response = parseInt($(this).val()) || 10;
        cfrSaveDebounced();
    });
}

function loadExtensionSettingsUI() {
    $('#cfr-enabled').prop('checked',        cfrSettings.enabled);
    $('#cfr-auto-parse').prop('checked',     cfrSettings.auto_parse_forge);
    $('#cfr-inject-details').prop('checked', cfrSettings.inject_details);
    $('#cfr-hide-forge').prop('checked',     cfrSettings.hide_forge_blocks);
    $('#cfr-debug').prop('checked',          cfrSettings.debug_mode);
    $('#cfr-cp-per-resp').val(               cfrSettings.cp_per_response);
}


// ============================================================
//  MESSAGE HANDLING
// ============================================================

function onMessageReceived(data) {
    if (!cfrTracker || !cfrSettings?.enabled) return;

    // Index-based dedup
    const ctx   = SillyTavern.getContext();
    const idx   = (ctx?.chat?.length ?? 0) - 1;
    if (idx <= cfrLastMsgIdx) return;
    cfrLastMsgIdx = idx;

    const text = typeof data === 'string' ? data
               : (data?.message || data?.mes || data?.content || '');
    if (!text) return;

    if (cfrSettings.debug_mode) console.log('[CFR] 📨 Processing message idx', idx);

    cfrTracker.processResponse(text);

    // Inject details into last message after a short delay
    // (DOM may not be updated synchronously with the event)
    setTimeout(() => {
        refreshLastDetail();
        hideForgeBlocks();
    }, 300);
}

function onChatChanged() {
    if (!cfrTracker) return;
    cfrTracker.load();
    cfrLastMsgIdx = -1;
    updateTrackerUI();
    updateHUD();
    setTimeout(() => {
        refreshAllDetails();
        hideForgeBlocks();
    }, 500);
    if (cfrSettings?.debug_mode) console.log('[CFR] 💬 Chat changed, state reloaded');
}


// ============================================================
//  MUTATION OBSERVER — backup + forge hiding + details refresh
// ============================================================

function setupObserver() {
    const chat = document.getElementById('chat');
    if (!chat) { console.warn('[CFR] #chat not found, observer disabled'); return; }

    if (cfrObserver) cfrObserver.disconnect();

    cfrObserver = new MutationObserver(mutations => {
        if (!cfrTracker || !cfrSettings?.enabled) return;

        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== 1) continue;

                // New AI message element added to chat
                if (node.classList?.contains('mes') && !node.classList.contains('is_user')) {
                    setTimeout(() => {
                        const text = node.querySelector('.mes_text')?.textContent || '';
                        if (text) onMessageReceived(text);
                        injectDetailsIntoMessage(node);
                        hideForgeBlocks();
                    }, 200);
                }

                // A pre/code block added — might be forge block
                if (node.tagName === 'PRE' || node.querySelector?.('pre')) {
                    setTimeout(() => hideForgeBlocks(), 100);
                }
            }
        }
    });

    cfrObserver.observe(chat, { childList: true, subtree: true });
    console.log('[CFR] 👁️ MutationObserver active');
}


// ============================================================
//  SILLYTAVERN INIT
// ============================================================

function loadSettings() {
    const ctx        = SillyTavern.getContext();
    cfrExtSettings   = ctx.extensionSettings;
    cfrSaveDebounced = ctx.saveSettingsDebounced;
    cfrEventSource   = ctx.eventSource;
    cfrEventTypes    = ctx.event_types;

    if (!cfrExtSettings[CFR_MODULE]) {
        cfrExtSettings[CFR_MODULE] = { ...CFR_DEFAULTS };
        cfrSaveDebounced();
    }
    cfrSettings = cfrExtSettings[CFR_MODULE];
    return cfrSettings;
}

function setupEventListeners() {
    if (!cfrEventSource || !cfrEventTypes) {
        console.error('[CFR] ST event system unavailable');
        return;
    }

    const msgEvents = ['MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','MESSAGE_RENDERED','CHAT_MESSAGE_RECEIVED'];
    let bound = 0;

    for (const name of msgEvents) {
        if (cfrEventTypes[name]) {
            cfrEventSource.on(cfrEventTypes[name], onMessageReceived);
            bound++;
            console.log(`[CFR] ✅ Bound: ${name}`);
        }
    }

    if (cfrEventTypes.CHAT_CHANGED) {
        cfrEventSource.on(cfrEventTypes.CHAT_CHANGED, onChatChanged);
        bound++;
        console.log('[CFR] ✅ Bound: CHAT_CHANGED');
    }

    console.log(`[CFR] 🎯 ${bound} events bound`);
}

jQuery(async () => {
    console.log('[CFR] 🚀 Celestial Forge Reformed v1.0.0 initializing…');

    loadSettings();

    // Inject tracker drawer into ST Extensions panel
    $('#extensions_settings').append(getCFRSettingsHtml());

    // Build tracker
    cfrTracker = new CelestialForgeTracker();
    cfrTracker.load();

    // Inject HUD
    injectHUD();

    // Bind all events
    bindManualControls();
    bindExtensionSettings();
    loadExtensionSettingsUI();

    // Initial UI render
    updateTrackerUI();
    updateHUD();

    // Expose globals
    window.cfrTracker              = cfrTracker;
    window.CelestialForgeTracker   = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => cfrTracker?.toContextBlock()      || '';
    window.getCelestialForgeJSON      = () => cfrTracker?.toForgeInjection()    || '';

    // ST event listeners
    setupEventListeners();

    // MutationObserver (backup + forge hiding)
    setTimeout(() => {
        setupObserver();
        refreshAllDetails();
        hideForgeBlocks();
    }, 1000);

    console.log('[CFR] ✨ Ready!', cfrTracker.status());
});

// NOTE: No `export` statement — ST loads this as a plain script,
// not an ES module. Use window.cfrTracker for console access.
