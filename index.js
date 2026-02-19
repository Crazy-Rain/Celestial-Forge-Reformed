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
    hide_forge_blocks:     true,
    gist_id:               '',
    gist_pat:              '',
    bank_max:              10
};

// Constellation display names (key → label)
const CFR_CONSTELLATIONS = {
    INDUSTRY:               'Industry',
    ARCANE_CORE:            'Arcane Core',
    DIGITAL_DOMAIN:         'Digital Domain',
    EQUIVALENCE:            'Equivalence',
    ARCHITECTURAL_FORGE:    'Architectural Forge',
    CULINARY_ARTS:          'Culinary Arts',
    TEXTILE_WEAVE:          'Textile Weave',
    SPIRAL_WORKS:           'Spiral Works',
    MARTIAL_CONSTELLATION:  'Martial Constellation',
    CHIMERIC_ARTS:          'Chimeric Arts',
    ELEMENTAL_DOMINION:     'Elemental Dominion',
    SHADOW_ARTS:            'Shadow Arts',
    ELDRITCH_INSIGHT:       'Eldritch Insight',
    TEMPORAL_SMITHING:      'Temporal Smithing',
    CONCEPTUAL_SMITHING:    'Conceptual Smithing',
    DIMENSIONAL_WEAVE:      'Dimensional Weave',
    DREAM_WEAVING:          'Dream Weaving',
    PSYCHIC_WEAVE:          'Psychic Weave',
    DUST_AND_AURA:          'Dust & Aura',
    CHAKRA_CRAFTING:        'Chakra Crafting',
    HARMONIC_FORGE:         'Harmonic Forge',
    CONTRACTS_AND_PACTS:    'Contracts & Pacts',
    FORGE_RESISTANCE:       'Forge Resistance',
    RESTORATION:            'Restoration',
    QUALITY_FORGE:          'Quality Forge',
    LIVING_WORKS:           'Living Works',
    INFINITE_STORAGE:       'Infinite Storage',
    FORTUNES_WHEEL:         "Fortune's Wheel",
    STELLAR_VOYAGER:        'Stellar Voyager',
    VEHICLE_CONSTELLATION:  'Vehicle Constellation',
    DIVINE_LIGHT:           'Divine Light',
    DEATHS_CRAFT:           "Death's Craft",
    VERDANT_HEART:          'Verdant Heart',
    MERCHANTS_CONSTELLATION:"Merchant's Constellation",
    ILLUSION_ARTS:          'Illusion Arts',
    CARNAL_ARTIFICE:        'Carnal Artifice'
};

const CFR_TIER_LABELS = {
    1: 'Foundation',
    2: 'Journeyman',
    3: 'Expert',
    4: 'Master',
    5: 'Transcendent',
    6: 'Mythic'
};

// Tier from CP cost
function cfrTierFromCost(cp) {
    if (cp <= 100)  return 1;
    if (cp <= 200)  return 2;
    if (cp <= 350)  return 3;
    if (cp <= 500)  return 4;
    if (cp <= 700)  return 5;
    return 6;
}

// Paragraph minimum per tier for generation prompt
function cfrDescParas(tier) {
    if (tier <= 2) return 1;
    if (tier <= 4) return 2;
    return 3;
}

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
            response_count:     0,
            base_cp:            0,
            bonus_cp:           0,
            total_cp:           0,
            spent_cp:           0,
            available_cp:       0,
            threshold:          100,
            threshold_progress: 0,
            corruption:         0,
            sanity:             0,
            acquired_perks:     [],
            banked_perks:       [],   // replaces single pending_perk; max 10
            pending_perk:       null, // kept for forge-block compat, maps to banked_perks[0]
            active_toggles:     [],
            perk_history:       [],
            has_uncapped:       false,
            has_gamer:          false
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
            name:               (data.name || 'Unknown').trim(),
            cost:               parseInt(data.cost) || 0,
            flags,
            description:        data.description || '',
            scaling_description:data.scaling_description || null,
            toggleable:         flags.includes('TOGGLEABLE'),
            active:             data.active !== false,
            scaling:            hasScaling ? this.makeScaling(data) : null,
            acquired_at:        data.acquired_at || Date.now(),
            acquired_response:  data.acquired_response || this.state.response_count
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

    // ── BANKING ──────────────────────────────────────────────

    bankPerk(perkData, constellation = '') {
        const max = this.getSetting('bank_max') || 10;
        if (!this.state.banked_perks) this.state.banked_perks = [];
        if (this.state.banked_perks.length >= max) {
            return { success: false, reason: 'bank_full', max };
        }
        const already = this.state.banked_perks.some(b =>
            b.name.toLowerCase() === (perkData.name || '').toLowerCase()
        );
        if (already) return { success: false, reason: 'already_banked' };

        this.state.banked_perks.push({
            name:          perkData.name,
            cost:          parseInt(perkData.cost) || 0,
            constellation,
            flags:         perkData.flags || [],
            description:   perkData.description || '',
            scaling:       perkData.scaling || null,
            banked_at:     Date.now(),
            source:        perkData.source || 'roll'
        });

        // Keep legacy pending_perk in sync for forge-block readers
        this.state.pending_perk = this.state.banked_perks[0]
            ? { name: this.state.banked_perks[0].name, cost: this.state.banked_perks[0].cost, cp_needed: this.state.banked_perks[0].cost - this.state.available_cp }
            : null;

        this.save();
        this.broadcast();
        this.log(`🏦 Perk banked: ${perkData.name}`);
        return { success: true };
    }

    acquireBanked(perkName) {
        if (!this.state.banked_perks) return { success: false, reason: 'no_bank' };
        const idx = this.state.banked_perks.findIndex(b =>
            b.name.toLowerCase() === perkName.toLowerCase()
        );
        if (idx === -1) return { success: false, reason: 'not_found' };
        const banked = this.state.banked_perks[idx];

        this.calcTotals();
        if (banked.cost > this.state.available_cp) {
            return { success: false, reason: 'insufficient_cp', cp_needed: banked.cost - this.state.available_cp };
        }

        this.state.banked_perks.splice(idx, 1);
        const result = this.addPerk(banked);

        // Resync legacy pending_perk
        this.state.pending_perk = this.state.banked_perks[0]
            ? { name: this.state.banked_perks[0].name, cost: this.state.banked_perks[0].cost, cp_needed: Math.max(0, this.state.banked_perks[0].cost - this.state.available_cp) }
            : null;

        this.save();
        this.broadcast();
        return result;
    }

    discardBanked(perkName) {
        if (!this.state.banked_perks) return { success: false };
        const before = this.state.banked_perks.length;
        this.state.banked_perks = this.state.banked_perks.filter(b =>
            b.name.toLowerCase() !== perkName.toLowerCase()
        );
        if (this.state.banked_perks.length === before) return { success: false, reason: 'not_found' };

        this.state.pending_perk = this.state.banked_perks[0]
            ? { name: this.state.banked_perks[0].name, cost: this.state.banked_perks[0].cost, cp_needed: Math.max(0, this.state.banked_perks[0].cost - this.state.available_cp) }
            : null;

        this.save();
        this.broadcast();
        this.log(`❌ Banked perk discarded: ${perkName}`);
        return { success: true };
    }

    // Called after any CP change — surfaces affordable banked perks as notifications
    checkBankAffordability() {
        if (!this.state.banked_perks?.length) return [];
        this.calcTotals();
        return this.state.banked_perks.filter(b => b.cost <= this.state.available_cp);
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
        updatePromptInjection();
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
//  GIST PERSISTENCE LAYER
// ============================================================

const CFR_GIST_DB_FILE    = 'cfr-perk-database.json';
const CFR_GIST_STATE_FILE = 'cfr-character-state.json';

let cfrPerkDB = null;       // in-memory perk database
let cfrGistFileShas = {};   // file SHAs needed for Gist PATCH

function gistHeaders() {
    return {
        'Authorization': `token ${cfrSettings?.gist_pat || ''}`,
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json'
    };
}

async function gistLoad() {
    const id  = cfrSettings?.gist_id;
    const pat = cfrSettings?.gist_pat;
    if (!id || !pat) {
        console.warn('[CFR] Gist not configured — using localStorage only');
        cfrPerkDB = cfrPerkDB || buildEmptyDB();
        return;
    }

    try {
        const res  = await fetch(`https://api.github.com/gists/${id}`, { headers: gistHeaders() });
        if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
        const data = await res.json();

        // Store SHAs so we can update files individually
        for (const [name, file] of Object.entries(data.files || {})) {
            cfrGistFileShas[name] = file.raw_url;
        }

        // Load perk database
        if (data.files[CFR_GIST_DB_FILE]) {
            const dbRes = await fetch(data.files[CFR_GIST_DB_FILE].raw_url);
            cfrPerkDB   = await dbRes.json();
        } else {
            cfrPerkDB = buildEmptyDB();
        }

        // Load character state (overrides localStorage if present)
        if (data.files[CFR_GIST_STATE_FILE] && cfrTracker) {
            const stRes   = await fetch(data.files[CFR_GIST_STATE_FILE].raw_url);
            const stData  = await stRes.json();
            if (stData.state) {
                cfrTracker.state = { ...cfrTracker.defaultState(), ...stData.state };
                cfrTracker.calcTotals();
            }
        }

        console.log('[CFR] ✅ Gist loaded successfully');
    } catch(e) {
        console.error('[CFR] Gist load failed:', e);
        if (!cfrPerkDB) cfrPerkDB = buildEmptyDB();
    }
}

async function gistSaveDB() {
    const id  = cfrSettings?.gist_id;
    const pat = cfrSettings?.gist_pat;
    if (!id || !pat || !cfrPerkDB) return;

    cfrPerkDB.last_updated = new Date().toISOString();

    try {
        await fetch(`https://api.github.com/gists/${id}`, {
            method:  'PATCH',
            headers: gistHeaders(),
            body:    JSON.stringify({
                files: {
                    [CFR_GIST_DB_FILE]: {
                        content: JSON.stringify(cfrPerkDB, null, 2)
                    }
                }
            })
        });
        if (cfrSettings?.debug_mode) console.log('[CFR] 📤 Perk DB saved to Gist');
    } catch(e) {
        console.error('[CFR] Gist DB save failed:', e);
    }
}

async function gistSaveState() {
    const id  = cfrSettings?.gist_id;
    const pat = cfrSettings?.gist_pat;
    if (!id || !pat || !cfrTracker) return;

    try {
        await fetch(`https://api.github.com/gists/${id}`, {
            method:  'PATCH',
            headers: gistHeaders(),
            body:    JSON.stringify({
                files: {
                    [CFR_GIST_STATE_FILE]: {
                        content: JSON.stringify({
                            version:        '1.0.0',
                            character_name: 'Smith',
                            last_updated:   new Date().toISOString(),
                            state:          cfrTracker.state
                        }, null, 2)
                    }
                }
            })
        });
        if (cfrSettings?.debug_mode) console.log('[CFR] 📤 Character state saved to Gist');
    } catch(e) {
        console.error('[CFR] Gist state save failed:', e);
    }
}

function buildEmptyDB() {
    const constellations = {};
    for (const key of Object.keys(CFR_CONSTELLATIONS)) {
        constellations[key] = { domain: '', theme: '', perks: [] };
    }
    return { version: '1.0.0', last_updated: '', constellations };
}

// Add a perk to the database for a constellation
async function dbAddPerk(constellationKey, perkData) {
    if (!cfrPerkDB) cfrPerkDB = buildEmptyDB();
    if (!cfrPerkDB.constellations[constellationKey]) {
        cfrPerkDB.constellations[constellationKey] = { domain: '', theme: '', perks: [] };
    }

    const existing = cfrPerkDB.constellations[constellationKey].perks.find(p =>
        p.name.toLowerCase() === perkData.name.toLowerCase()
    );
    if (existing) return { success: false, reason: 'duplicate', existing };

    const tier = cfrTierFromCost(perkData.cost);
    cfrPerkDB.constellations[constellationKey].perks.push({
        id:                 `${constellationKey.toLowerCase()}_${Date.now()}`,
        name:               perkData.name,
        cost:               perkData.cost,
        tier,
        tier_label:         CFR_TIER_LABELS[tier] || '',
        flags:              perkData.flags || [],
        description:        perkData.description || '',
        scaling_description:perkData.scaling_description || null,
        times_rolled:       0,
        created_at:         new Date().toISOString(),
        source:             perkData.source || 'generation'
    });

    await gistSaveDB();
    return { success: true };
}

// Pull a random perk from a constellation
function dbRollPerk(constellationKey) {
    const list = cfrPerkDB?.constellations?.[constellationKey]?.perks || [];
    if (!list.length) return null;
    const perk = list[Math.floor(Math.random() * list.length)];
    perk.times_rolled = (perk.times_rolled || 0) + 1;
    gistSaveDB(); // async, fire and forget
    return perk;
}

// Pick a random constellation key
function dbRandomConstellation() {
    const keys = Object.keys(CFR_CONSTELLATIONS);
    return keys[Math.floor(Math.random() * keys.length)];
}


// ============================================================
//  ROLL SYSTEM
// ============================================================

// Active roll state — what's currently pending player decision
let cfrActiveRoll = null;
// 'creation_pending' means we injected the generation prompt, waiting for AI response
let cfrAwaitingCreation = false;
let cfrCreationConstellation = null;

function buildCreationPrompt(constellationKey, tier) {
    const constData = cfrPerkDB?.constellations?.[constellationKey];
    const label     = CFR_CONSTELLATIONS[constellationKey] || constellationKey;
    const theme     = constData?.theme || '';
    const existing  = (constData?.perks || []).map(p => p.name).join(', ') || 'none yet';
    const tierLabel = CFR_TIER_LABELS[tier] || 'Expert';
    const cpRanges  = ['','50-100','100-200','200-350','350-500','500-700','700-1000'];
    const cpRange   = cpRanges[tier] || '200-350';
    const parasMin  = cfrDescParas(tier);
    const available = cfrTracker?.state?.available_cp || 0;
    const descReq   = parasMin === 1
        ? 'at least 1 full paragraph'
        : parasMin === 2 ? '2 to 3 full paragraphs' : '3 full paragraphs';

    return `[CELESTIAL FORGE - CREATION ROLL - EXECUTE THIS BEFORE ALL ELSE]
A Celestial Forge Creation Roll has been triggered. YOUR FIRST PRIORITY in this response is to generate the perk below, weaving it naturally into the narrative. Do not skip or defer this step.

CONSTELLATION: ${label}
DOMAIN THEME: ${theme}
TIER: ${tier} - ${tierLabel}
CP COST RANGE: ${cpRange} CP
PLAYER CURRENT CP: ${available}

MANDATORY OUTPUT FORMAT:
Your perk header MUST appear on its own line in EXACTLY this format:
**[Perk Name]** (X CP) [FLAG1, FLAG2, FLAG3]

CORRECT EXAMPLE:
**Ember Heart** (250 CP) [PASSIVE, SCALING, CORRUPTING]

WRONG (do not do this):
**PERK NAME:** Ember Heart (250 CP) [PASSIVE, SCALING, CORRUPTING]

The perk name must be the bolded text itself, not a label. Cost in parentheses, flags in square brackets, all on one line.

Valid flags: PASSIVE, TOGGLEABLE, ALWAYS-ON, SCALING, UNCAPPED, GAMER, META-SCALING, CORRUPTING, SANITY-TAXING, COMBAT, UTILITY, CRAFTING, MENTAL, PHYSICAL, SELECTIVE

DESCRIPTION: ${descReq} immediately after the header line.
- Tier 1-2: What the perk does, simply and clearly
- Tier 3-4: Include nuance, edge cases, costs and drawbacks
- Tier 5-6: Scope, hard limits, and how it fundamentally changes the character

If the perk has the SCALING flag, add this section after the description:
SCALING:
1-3: [What the perk does at beginner mastery]
4-6: [What it does at journeyman mastery]
7-9: [What it does at expert mastery]
10: [What it does at apex mastery]

Do NOT duplicate existing ${label} perks: ${existing}

After the perk, output an updated forge block with the perk in pending_perk (unaffordable) or perks array (affordable).
[END CREATION ROLL]`;
}

// Trigger a forge roll — picks from DB
async function triggerForgeRoll(constellationKey) {
    if (!cfrPerkDB) await gistLoad();

    const key   = constellationKey || dbRandomConstellation();
    const label = CFR_CONSTELLATIONS[key] || key;
    const perk  = dbRollPerk(key);

    if (!perk) {
        showRollResult(null, key, label, 'forge');
        return;
    }

    cfrActiveRoll = { type: 'forge', perk, constellationKey: key, constellationLabel: label };
    showRollResult(perk, key, label, 'forge');
}

// Trigger a creation roll — injects prompt for AI generation
async function triggerCreationRoll(constellationKey, tier) {
    if (!cfrPerkDB) await gistLoad();

    const key   = constellationKey || dbRandomConstellation();
    const label = CFR_CONSTELLATIONS[key] || key;
    const t     = tier || Math.ceil(Math.random() * 4) + 1; // weighted toward mid tiers

    cfrCreationConstellation = key;
    cfrAwaitingCreation      = true;

    const prompt = buildCreationPrompt(key, t);

    // Inject into ST prompt + show user what's about to be sent
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('cfr-creation-roll', prompt, 0, 0);
        }
    } catch(e) { console.warn('[CFR] Creation prompt inject failed:', e); }

    showCreationPending(key, label, t);
}

// After a creation roll — AI has responded, parse the new perk
async function finalizeCreationRoll(text) {
    if (!cfrAwaitingCreation) return;
    cfrAwaitingCreation = false;

    // Clear creation prompt injection
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('cfr-creation-roll', '', 0, 0);
        }
    } catch(e) {}

    let perk = null;

    // ── Strategy 1: Correct format  **Name** (X CP) [FLAGS]
    // Anchored to start of line to avoid matching mid-sentence bold text
    const matchDirect = text.match(/^\*\*([^*:\n]+?)\*\*\s*\((\d+)\s*CP\)\s*\[([^\]]*)\]/m);
    if (matchDirect) {
        perk = parsePerkFromMatch(matchDirect, text);
        console.log('[CFR] Parsed perk via Strategy 1 (direct format)');
    }

    // ── Strategy 2: Labeled format  **PERK NAME:** Name (X CP) [FLAGS]
    // AI sometimes treats the format spec as literal field labels
    if (!perk) {
        const matchLabeled = text.match(/\*\*PERK\s*NAME[:\s]*\*\*\s*([^(\n]+?)\s*\((\d+)\s*CP\)\s*\[([^\]]*)\]/i);
        if (matchLabeled) {
            perk = {
                name:        matchLabeled[1].trim(),
                cost:        parseInt(matchLabeled[2]),
                flags:       matchLabeled[3].split(/[,\s]+/).map(f=>f.trim()).filter(Boolean),
                description: extractDescription(text, matchLabeled[0]),
                scaling_description: extractScalingDescription(text),
                source:      'generation'
            };
            console.log('[CFR] Parsed perk via Strategy 2 (labeled format)');
        }
    }

    // ── Strategy 3: Forge block fallback
    // AI wrote a valid forge block — extract pending_perk from it
    if (!perk) {
        const forgeMatch = text.match(/```forge\s*([\s\S]*?)```/);
        if (forgeMatch) {
            try {
                const forgeData = JSON.parse(forgeMatch[1].trim());
                const stats     = forgeData.characters?.[0]?.stats || forgeData;
                if (stats.pending_perk) {
                    perk = {
                        name:        stats.pending_perk,
                        cost:        stats.pending_cp || 0,
                        flags:       [],
                        description: extractDescriptionFromText(text, stats.pending_perk),
                        source:      'generation'
                    };
                    console.log('[CFR] Parsed perk via Strategy 3 (forge block fallback)');
                }
            } catch(e) {
                console.warn('[CFR] Strategy 3 forge parse failed:', e.message);
            }
        }
    }

    if (!perk) {
        console.warn('[CFR] Creation roll: all parse strategies failed. AI may not have followed format.');
        showRollToast('Could not parse perk from AI response — check format', true);
        return;
    }

    cfrActiveRoll = {
        type:               'creation',
        perk,
        constellationKey:   cfrCreationConstellation,
        constellationLabel: CFR_CONSTELLATIONS[cfrCreationConstellation] || cfrCreationConstellation
    };

    // Open HUD if closed so player sees the result card
    const hud = document.getElementById('cfr-hud');
    const btn = document.getElementById('cfr-hud-btn');
    if (hud && hud.classList.contains('hidden')) {
        hud.classList.remove('hidden');
        if (btn) btn.classList.add('open');
    }

    showRollResult(perk, cfrActiveRoll.constellationKey, cfrActiveRoll.constellationLabel, 'creation');
}

// ── Parse helpers ─────────────────────────────────────────────

function parsePerkFromMatch(match, fullText) {
    const afterHeader = fullText.slice(fullText.indexOf(match[0]) + match[0].length).trim();
    return {
        name:               match[1].trim(),
        cost:               parseInt(match[2]),
        flags:              match[3].split(/[,\s]+/).map(f=>f.trim()).filter(Boolean),
        description:        extractDescription(fullText, match[0]),
        scaling_description:extractScalingDescription(fullText),
        source:             'generation'
    };
}

function extractDescription(text, headerStr) {
    const afterHeader = text.slice(text.indexOf(headerStr) + headerStr.length).trim();
    const withoutForge = afterHeader.replace(/```forge[\s\S]*?```/g, '').trim();
    // Stop before SCALING: section
    const scalingIdx = withoutForge.search(/^SCALING:/m);
    const descText   = scalingIdx > -1 ? withoutForge.slice(0, scalingIdx).trim() : withoutForge;
    const paragraphs = descText.split(/\n\n+/).filter(p => p.trim().length > 20).slice(0, 3);
    return paragraphs.join('\n\n').trim();
}

function extractDescriptionFromText(text, perkName) {
    // Find description near the perk name mention
    const nameIdx = text.toLowerCase().indexOf(perkName.toLowerCase());
    if (nameIdx === -1) return '';
    const after    = text.slice(nameIdx + perkName.length);
    const cleaned  = after.replace(/```forge[\s\S]*?```/g, '').trim();
    const paragraphs = cleaned.split(/\n\n+/).filter(p => p.trim().length > 20).slice(0, 3);
    return paragraphs.join('\n\n').trim();
}

function extractScalingDescription(text) {
    // Look for SCALING: section with tier breakpoints
    const scalingMatch = text.match(/SCALING:\s*\n([\s\S]*?)(?=\n\n|```forge|$)/);
    if (!scalingMatch) return null;

    const lines  = scalingMatch[1].split('\n').filter(l => l.trim());
    const result = {};
    for (const line of lines) {
        const m = line.match(/^(\d+(?:-\d+)?):\s*(.+)/);
        if (m) result[m[1]] = m[2].trim();
    }
    return Object.keys(result).length ? result : null;
}

// Player clicks Acquire
async function rollAcquire() {
    if (!cfrActiveRoll) return;
    const { perk, constellationKey, type } = cfrActiveRoll;

    const result = cfrTracker.addPerk(perk);

    // Add to DB regardless of whether player could afford it
    await dbAddPerk(constellationKey, { ...perk, source: type });

    if (!result.success && result.reason === 'insufficient_cp') {
        // Auto-bank since they tried to acquire but can't afford
        cfrTracker.bankPerk(perk, constellationKey);
        showRollToast(`💡 Can't afford yet — ${perk.name} banked automatically`);
    } else {
        showRollToast(`✅ ${perk.name} acquired!`);
    }

    cfrActiveRoll = null;
    hideRollCard();
    checkAndNotifyBank();
}

// Player clicks Bank
async function rollBank() {
    if (!cfrActiveRoll) return;
    const { perk, constellationKey, type } = cfrActiveRoll;

    // Add to DB on bank too (perk was generated/rolled, it exists)
    await dbAddPerk(constellationKey, { ...perk, source: type });

    const result = cfrTracker.bankPerk(perk, constellationKey);
    if (result.success) {
        showRollToast(`🏦 ${perk.name} banked (${(cfrTracker.state.banked_perks||[]).length}/${cfrSettings?.bank_max||10} slots)`);
    } else {
        showRollToast(`⚠️ Bank full (${result.max} slots max) — discard something first`, true);
    }

    cfrActiveRoll = null;
    hideRollCard();
}

// Player clicks Discard
function rollDiscard() {
    if (!cfrActiveRoll) return;
    const name = cfrActiveRoll.perk?.name || 'perk';
    cfrActiveRoll = null;
    hideRollCard();
    showRollToast(`❌ ${name} discarded — no CP spent`);
    // Do NOT add to DB on discard
}

// Check if any banked perks are now affordable after CP change
function checkAndNotifyBank() {
    if (!cfrTracker) return;
    const affordable = cfrTracker.checkBankAffordability();
    if (!affordable.length) return;

    // Show notification for first affordable banked perk
    const p = affordable[0];
    showBankNotification(p);
}


// ============================================================
//  ROLL UI (injected into HUD)
// ============================================================

function getRollPanelHTML() {
    const constellationOptions = Object.entries(CFR_CONSTELLATIONS)
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join('');

    const tierOptions = Object.entries(CFR_TIER_LABELS)
        .map(([k, v]) => `<option value="${k}">Tier ${k} — ${v}</option>`)
        .join('');

    return `
<div id="cfr-roll-panel" style="padding:10px 15px; border-top:1px solid #1a1a2e; flex-shrink:0;">
  <div style="font-size:10px; color:#e94560; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">⚄ The Forge</div>

  <div style="margin-bottom:6px;">
    <select id="cfr-roll-constellation" style="width:100%;padding:4px 6px;background:#111;border:1px solid #333;color:#ccc;border-radius:4px;font-size:11px;">
      <option value="">🎲 Random Constellation</option>
      ${constellationOptions}
    </select>
  </div>

  <div style="margin-bottom:8px;">
    <select id="cfr-roll-tier" style="width:100%;padding:4px 6px;background:#111;border:1px solid #333;color:#ccc;border-radius:4px;font-size:11px;">
      <option value="">🎲 Random Tier (Creation only)</option>
      ${tierOptions}
    </select>
  </div>

  <div style="display:flex;gap:6px;">
    <button id="cfr-btn-forge-roll" style="flex:1;padding:6px 4px;background:rgba(233,69,96,0.15);border:1px solid #e94560;border-radius:4px;color:#e94560;font-size:11px;cursor:pointer;">📜 Forge Roll</button>
    <button id="cfr-btn-creation-roll" style="flex:1;padding:6px 4px;background:rgba(255,215,0,0.1);border:1px solid #ffd700;border-radius:4px;color:#ffd700;font-size:11px;cursor:pointer;">⚄ Creation Roll</button>
  </div>

  <!-- Roll result card -->
  <div id="cfr-roll-card" style="display:none; margin-top:10px; background:rgba(0,0,0,0.4); border:1px solid #444; border-radius:6px; padding:10px; font-size:12px;">
    <div id="cfr-roll-card-inner"></div>
    <div style="display:flex;gap:5px;margin-top:8px;" id="cfr-roll-buttons">
      <button onclick="rollAcquire()" style="flex:1;padding:5px;background:rgba(46,204,113,0.2);border:1px solid #2ecc71;border-radius:4px;color:#2ecc71;font-size:11px;cursor:pointer;">✅ Acquire</button>
      <button onclick="rollBank()"    style="flex:1;padding:5px;background:rgba(241,196,15,0.1);border:1px solid #f1c40f;border-radius:4px;color:#f1c40f;font-size:11px;cursor:pointer;">🏦 Bank</button>
      <button onclick="rollDiscard()" style="flex:1;padding:5px;background:rgba(231,76,60,0.15);border:1px solid #e74c3c;border-radius:4px;color:#e74c3c;font-size:11px;cursor:pointer;">❌ Discard</button>
    </div>
  </div>

  <!-- Toast notification -->
  <div id="cfr-roll-toast" style="display:none; margin-top:8px; padding:6px 10px; border-radius:4px; font-size:11px;"></div>
</div>

<!-- Bank notification overlay -->
<div id="cfr-bank-notify" style="display:none; position:absolute; bottom:60px; left:10px; right:10px; background:rgba(16,18,36,0.97); border:1px solid #f1c40f; border-radius:6px; padding:10px; font-size:12px; z-index:10;">
  <div style="color:#f1c40f; font-size:10px; text-transform:uppercase; margin-bottom:4px;">🏦 Banked Perk Affordable</div>
  <div id="cfr-bank-notify-name" style="color:#fff; font-weight:bold;"></div>
  <div id="cfr-bank-notify-info" style="color:#888; font-size:11px; margin-top:2px;"></div>
  <div style="display:flex;gap:5px;margin-top:8px;">
    <button id="cfr-bank-notify-yes" style="flex:1;padding:4px;background:rgba(46,204,113,0.2);border:1px solid #2ecc71;border-radius:4px;color:#2ecc71;font-size:11px;cursor:pointer;">✅ Acquire Now</button>
    <button id="cfr-bank-notify-no"  style="flex:1;padding:4px;background:#1a1a2e;border:1px solid #444;border-radius:4px;color:#666;font-size:11px;cursor:pointer;">Later</button>
  </div>
</div>

<!-- Banked perks list -->
<div id="cfr-banked-section" style="display:none; padding:0 15px 10px; flex-shrink:0; border-top:1px solid #1a1a2e;">
  <div style="font-size:10px;color:#f1c40f;text-transform:uppercase;letter-spacing:1px;padding:8px 0 4px;">🏦 Banked Perks (<span id="cfr-bank-count">0</span>/10)</div>
  <div id="cfr-bank-list"></div>
</div>`;
}

function showRollResult(perk, constellationKey, constellationLabel, type) {
    const card  = document.getElementById('cfr-roll-card');
    const inner = document.getElementById('cfr-roll-card-inner');
    if (!card || !inner) return;

    if (!perk) {
        inner.innerHTML = `
            <div style="color:#e94560;font-weight:bold;margin-bottom:4px;">📜 ${constellationLabel}</div>
            <div style="color:#666;font-size:11px;">No perks in this constellation's database yet.<br>Try a Creation Roll to generate the first one!</div>`;
        document.getElementById('cfr-roll-buttons').style.display = 'none';
        card.style.display = 'block';
        return;
    }

    const tier      = cfrTierFromCost(perk.cost);
    const tierLabel = CFR_TIER_LABELS[tier] || '';
    const typeLabel = type === 'creation' ? '⚄ Created' : '📜 Rolled';
    const flagsHtml = (perk.flags || []).map(f =>
        `<span style="font-size:9px;padding:1px 5px;background:#1a1a2e;border-radius:3px;color:#888;">${f}</span>`
    ).join(' ');
    const affordable  = (perk.cost || 0) <= (cfrTracker?.state?.available_cp || 0);
    const cpColor     = affordable ? '#2ecc71' : '#e94560';
    const availableCP = cfrTracker?.state?.available_cp || 0;

    inner.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
          <span style="color:#e94560;font-size:10px;">${typeLabel} · ${constellationLabel}</span>
          <span style="color:#555;font-size:10px;">Tier ${tier} · ${tierLabel}</span>
        </div>
        <div style="color:#fff;font-weight:bold;font-size:13px;margin-bottom:3px;">${perk.name}</div>
        <div style="color:${cpColor};font-size:11px;margin-bottom:5px;">${perk.cost} CP ${affordable ? '✓' : `(need ${perk.cost - availableCP} more)`}</div>
        <div style="margin-bottom:5px;">${flagsHtml}</div>
        <div style="color:#999;font-size:11px;line-height:1.5;max-height:120px;overflow-y:auto;">${perk.description || ''}</div>`;

    document.getElementById('cfr-roll-buttons').style.display = 'flex';
    card.style.display = 'block';
}

function showCreationPending(constellationKey, label, tier) {
    const card  = document.getElementById('cfr-roll-card');
    const inner = document.getElementById('cfr-roll-card-inner');
    if (!card || !inner) return;

    inner.innerHTML = `
        <div style="color:#ffd700;font-weight:bold;margin-bottom:4px;">⚄ Creation Roll — ${label}</div>
        <div style="color:#aaa;font-size:11px;line-height:1.5;">
          Tier ${tier} (${CFR_TIER_LABELS[tier] || ''}) generation prompt injected.<br>
          <span style="color:#555;">Add context to your next message if desired, then send it.<br>
          The AI will generate a new perk for this constellation.</span>
        </div>`;

    document.getElementById('cfr-roll-buttons').style.display = 'none';
    card.style.display = 'block';
}

function hideRollCard() {
    const card = document.getElementById('cfr-roll-card');
    if (card) card.style.display = 'none';
}

function showRollToast(msg, isError = false) {
    const toast = document.getElementById('cfr-roll-toast');
    if (!toast) return;
    toast.textContent  = msg;
    toast.style.display = 'block';
    toast.style.background = isError ? 'rgba(231,76,60,0.15)' : 'rgba(46,204,113,0.1)';
    toast.style.color       = isError ? '#e74c3c' : '#2ecc71';
    toast.style.border      = `1px solid ${isError ? '#e74c3c' : '#2ecc71'}`;
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

let cfrBankNotifyPerk = null;
function showBankNotification(perk) {
    cfrBankNotifyPerk = perk;
    const el = document.getElementById('cfr-bank-notify');
    if (!el) return;
    document.getElementById('cfr-bank-notify-name').textContent = perk.name;
    document.getElementById('cfr-bank-notify-info').textContent = `${perk.cost} CP · ${perk.constellation || ''}`;
    el.style.display = 'block';
}

function updateBankedList() {
    const banked = cfrTracker?.state?.banked_perks || [];
    const count  = document.getElementById('cfr-bank-count');
    const list   = document.getElementById('cfr-bank-list');
    const section= document.getElementById('cfr-banked-section');

    if (count) count.textContent = banked.length;
    if (section) section.style.display = banked.length ? 'block' : 'none';
    if (!list) return;

    if (!banked.length) { list.innerHTML = ''; return; }

    list.innerHTML = banked.map(b => {
        const affordable = b.cost <= (cfrTracker?.state?.available_cp || 0);
        const color      = affordable ? '#2ecc71' : '#888';
        return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1a1a2e;font-size:11px;">
              <span style="color:#ccc;">${b.name}</span>
              <span style="display:flex;align-items:center;gap:6px;">
                <span style="color:${color};">${b.cost} CP</span>
                ${affordable ? `<button onclick="cfrTracker.acquireBanked('${b.name}');updateBankedList();updateHUD();" style="padding:2px 6px;background:rgba(46,204,113,0.15);border:1px solid #2ecc71;border-radius:3px;color:#2ecc71;font-size:9px;cursor:pointer;">Acquire</button>` : ''}
                <button onclick="cfrTracker.discardBanked('${b.name}');updateBankedList();" style="padding:2px 6px;background:rgba(231,76,60,0.1);border:1px solid #e74c3c33;border-radius:3px;color:#e74c3c;font-size:9px;cursor:pointer;">✕</button>
              </span>
            </div>`;
    }).join('');
}

function bindRollButtons() {
    $('#cfr-btn-forge-roll').on('click', () => {
        const key = $('#cfr-roll-constellation').val() || null;
        triggerForgeRoll(key);
    });

    $('#cfr-btn-creation-roll').on('click', () => {
        const key  = $('#cfr-roll-constellation').val() || null;
        const tier = parseInt($('#cfr-roll-tier').val()) || null;
        triggerCreationRoll(key, tier);
    });

    $('#cfr-bank-notify-yes').on('click', () => {
        if (!cfrBankNotifyPerk) return;
        const result = cfrTracker.acquireBanked(cfrBankNotifyPerk.name);
        showRollToast(result.success ? `✅ ${cfrBankNotifyPerk.name} acquired!` : `⚠️ ${result.reason}`);
        cfrBankNotifyPerk = null;
        $('#cfr-bank-notify').hide();
        updateBankedList();
    });

    $('#cfr-bank-notify-no').on('click', () => {
        cfrBankNotifyPerk = null;
        $('#cfr-bank-notify').hide();
    });
}

// Expose roll functions globally so inline onclick handlers work
window.rollAcquire = rollAcquire;
window.rollBank    = rollBank;
window.rollDiscard = rollDiscard;


// ============================================================
//  PROMPT INJECTION — pushes live state into every outgoing prompt
// ============================================================

// ST extension prompt positions:
//   0 = Before Main Prompt (system top)
//   1 = After Main Prompt
//   2 = Before World Info / After AN
// Depth: number of messages from bottom (0 = always injected at position)
// We use position 1, depth 0 — sits in the system block, always present,
// updated every time tracker state changes.

const CFR_PROMPT_KEY = 'celestial-forge-reformed-state';

function updatePromptInjection() {
    if (!cfrTracker) return;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt !== 'function') {
            // Fallback: older ST builds may not have this — warn once
            if (!window._cfrPromptWarnShown) {
                console.warn('[CFR] setExtensionPrompt not available — upgrade SillyTavern for prompt injection.');
                window._cfrPromptWarnShown = true;
            }
            return;
        }

        if (!cfrSettings?.enabled) {
            // Clear injection when disabled
            ctx.setExtensionPrompt(CFR_PROMPT_KEY, '', 0, 0);
            return;
        }

        const block = buildPromptBlock();
        // Position 1 = after main prompt, depth 0 = no in-chat depth offset
        ctx.setExtensionPrompt(CFR_PROMPT_KEY, block, 0, 0);

        if (cfrSettings?.debug_mode) {
            console.log('[CFR] 📤 Prompt injection updated');
        }
    } catch(e) {
        console.warn('[CFR] Prompt injection failed:', e);
    }
}

// Builds the injected text block — concise but complete.
// The lorebook already explains flag meanings and XP rules,
// so this block is pure current state, no definitions needed.
// Returns the appropriate scaling description text for a perk at its current level
function getCurrentScalingDesc(perk) {
    const sd = perk.scaling_description;
    if (!sd || typeof sd !== 'object') return null;
    const level = perk.scaling?.level || 1;

    // Check exact level match first (e.g. "10")
    if (sd[String(level)]) return sd[String(level)];

    // Check range keys like "1-3", "4-6", "7-9"
    for (const [key, val] of Object.entries(sd)) {
        const rangeMatch = key.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1]);
            const hi = parseInt(rangeMatch[2]);
            if (level >= lo && level <= hi) return val;
        }
    }

    // Uncapped — return last/highest range if past all defined tiers
    const keys = Object.keys(sd).sort((a,b) => {
        const aNum = parseInt(a.split('-').pop());
        const bNum = parseInt(b.split('-').pop());
        return aNum - bNum;
    });
    if (keys.length && perk.scaling?.uncapped) {
        return sd[keys[keys.length - 1]] + ' (further refined beyond apex)';
    }

    return null;
}

function buildPromptBlock() {
    if (!cfrTracker) return '';
    const s = cfrTracker.state;
    cfrTracker.calcTotals();

    const lines = [];

    lines.push('[CELESTIAL FORGE — LIVE STATE]');
    lines.push(`CP: ${s.available_cp} available | ${s.total_cp} total | ${s.spent_cp} spent`);
    lines.push(`Threshold progress: ${s.threshold_progress}/${s.threshold}`);
    lines.push(`Corruption: ${s.corruption}/100 | Sanity: ${s.sanity}/100`);

    const activeFlags = [];
    if (s.has_uncapped) activeFlags.push('UNCAPPED');
    if (s.has_gamer)    activeFlags.push('GAMER');
    if (activeFlags.length) lines.push(`Active global modifiers: ${activeFlags.join(', ')}`);

    if (s.acquired_perks.length === 0) {
        lines.push('Perks: none acquired yet');
    } else {
        lines.push(`Perks (${s.acquired_perks.length}):`);
        for (const p of s.acquired_perks) {
            let entry = `- ${p.name} (${p.cost} CP) [${p.flags.join(', ')}]`;

            if (p.scaling) {
                const maxL = p.scaling.uncapped ? 'Uncapped' : p.scaling.maxLevel;
                entry += ` [Level ${p.scaling.level}/${maxL} | ${p.scaling.xp}/${p.scaling.xp_needed} XP]`;
            }

            if (p.toggleable) {
                entry += p.active ? ' [ACTIVE]' : ' [INACTIVE — toggled off]';
            }

            // Use current-level scaling description if available, otherwise base description
            const currentDesc = getCurrentScalingDesc(p);
            if (currentDesc) {
                entry += `\n    Current effect: ${currentDesc}`;
            } else if (p.description) {
                entry += `\n    Effect: ${p.description}`;
            }

            lines.push(entry);
        }
    }

    if (s.pending_perk) {
        lines.push(`Pending (unaffordable): ${s.pending_perk.name} (${s.pending_perk.cost} CP — ${s.pending_perk.cp_needed} CP short)`);
    }

    lines.push('[END FORGE STATE]');

    return lines.join('\n');
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

      <!-- GIST SYNC -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">☁️ Gist Sync</div>
        <div class="cfr-settings-section">
          <div class="cfr-form-field">
            <label>Gist ID</label>
            <input type="text" id="cfr-gist-id" placeholder="e.g. a1b2c3d4e5f6..." />
          </div>
          <div class="cfr-form-field">
            <label>GitHub PAT (gist scope)</label>
            <input type="password" id="cfr-gist-pat" placeholder="ghp_..." />
          </div>
          <div class="cfr-btn-row" style="margin-top:6px;">
            <input type="button" class="menu_button" id="cfr-btn-gist-save" value="💾 Save & Connect" />
            <input type="button" class="menu_button" id="cfr-btn-gist-sync" value="🔄 Sync Now" />
          </div>
          <div id="cfr-gist-status" class="cfr-status-msg"></div>
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
          ${getRollPanelHTML()}
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

    updateBankedList();
    checkAndNotifyBank();
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

    // Gist settings
    $('#cfr-btn-gist-save').on('click', async () => {
        const id  = $('#cfr-gist-id').val().trim();
        const pat = $('#cfr-gist-pat').val().trim();
        if (!id || !pat) {
            showStatus('cfr-gist-status', '⚠️ Both Gist ID and PAT required', 'err');
            return;
        }
        cfrSettings.gist_id  = id;
        cfrSettings.gist_pat = pat;
        cfrSaveDebounced();
        showStatus('cfr-gist-status', '🔄 Connecting…', 'ok');
        await gistLoad();
        updateTrackerUI();
        updateHUD();
        showStatus('cfr-gist-status', '✅ Connected and synced', 'ok');
    });

    $('#cfr-btn-gist-sync').on('click', async () => {
        if (!cfrSettings?.gist_id) {
            showStatus('cfr-gist-status', '⚠️ Configure Gist ID and PAT first', 'err');
            return;
        }
        showStatus('cfr-gist-status', '🔄 Syncing…', 'ok');
        await gistLoad();
        await gistSaveState();
        updateTrackerUI();
        updateHUD();
        showStatus('cfr-gist-status', '✅ Synced', 'ok');
    });
}

function loadExtensionSettingsUI() {
    $('#cfr-enabled').prop('checked',        cfrSettings.enabled);
    $('#cfr-auto-parse').prop('checked',     cfrSettings.auto_parse_forge);
    $('#cfr-inject-details').prop('checked', cfrSettings.inject_details);
    $('#cfr-hide-forge').prop('checked',     cfrSettings.hide_forge_blocks);
    $('#cfr-debug').prop('checked',          cfrSettings.debug_mode);
    $('#cfr-cp-per-resp').val(               cfrSettings.cp_per_response);

    // Pre-fill Gist fields if already configured
    if (cfrSettings.gist_id)  $('#cfr-gist-id').val(cfrSettings.gist_id);
    if (cfrSettings.gist_pat) $('#cfr-gist-pat').val(cfrSettings.gist_pat);
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

    // If we were waiting for a creation roll response, handle it first
    if (cfrAwaitingCreation) {
        finalizeCreationRoll(text);
    }

    cfrTracker.processResponse(text);

    // Sync character state to Gist after each AI message (2s delay to batch rapid changes)
    setTimeout(() => gistSaveState(), 2000);

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

    // Inject HUD (includes roll panel HTML)
    injectHUD();

    // Bind all events
    bindManualControls();
    bindExtensionSettings();
    bindRollButtons();
    loadExtensionSettingsUI();

    // Initial UI render
    updateTrackerUI();
    updateHUD();
    updateBankedList();
    updatePromptInjection();

    // Expose globals
    window.cfrTracker                 = cfrTracker;
    window.CelestialForgeTracker      = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => cfrTracker?.toContextBlock()   || '';
    window.getCelestialForgeJSON      = () => cfrTracker?.toForgeInjection() || '';
    window.getCelestialForgePrompt    = () => buildPromptBlock()             || '';
    window.cfrPerkDB                  = () => cfrPerkDB; // read-only reference
    window.cfrGistSaveDB              = gistSaveDB;      // manual save trigger
    window.cfrGistSaveState           = gistSaveState;

    // ST event listeners
    setupEventListeners();

    // Load Gist data if configured (async, non-blocking)
    if (cfrSettings?.gist_id && cfrSettings?.gist_pat) {
        gistLoad().then(() => {
            updateTrackerUI();
            updateHUD();
            updateBankedList();
            updatePromptInjection();
            console.log('[CFR] ☁️ Gist sync complete on init');
        }).catch(e => console.warn('[CFR] Gist init load failed:', e));
    } else {
        cfrPerkDB = buildEmptyDB();
        console.log('[CFR] ℹ️ No Gist configured — using local DB only. Add Gist ID + PAT in Settings.');
    }

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
