// ============================================================
//  CELESTIAL FORGE REFORMED  v1.0.1
//  Single-extension replacement for celestial-forge-tracker
//  + celestial-forge-hud. No SimTracker dependency.
//
//  Fixes v1.0.1:
//   • UNCAPPED/GAMER label text — removed "active" from static HTML
//   • applyLastForgeBlock — was passing raw string to syncFromForge (crash)
//   • addPerk — removed name.includes('UNCAPPED') landmine
//   • extractScalingDescription — regex \n\n\n -> \n\n+ (standard AI spacing)
//   • scalingDescToText — sorts tier keys numerically before output
//   • setAvailableCP — removed redundant setTimeout(updatePromptInjection)
//   • passivePerkScan — uses matchAll, surfaces first unacquired perk
//   • dbRollPerk — returns shallow copy, not live DB reference
//   • onChatChanged — debounce guard prevents multi-fire on chat switch
//   • buildCreationPrompt — calls calcTotals() before reading available_cp
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
    bank_max:              10,
    active_profile:        'default'
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
        this.version = "1.0.1";
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

    // FIX: Removed redundant setTimeout(updatePromptInjection) — broadcast() already calls it
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

    makeScaling(data, active) {
        const isActive = active !== undefined
            ? active
            : !!(data?.scaling?.scaling_active ?? this.state.has_gamer);

        const base = {
            level:          1,
            maxLevel:       this.state.has_uncapped ? 999 : 10,
            xp:             0,
            xp_needed:      10,
            xp_percent:     0,
            uncapped:       this.state.has_uncapped,
            scaling_active: isActive
        };
        if (data?.scaling && typeof data.scaling === 'object') {
            return {
                level:          data.scaling.level          || base.level,
                maxLevel:       this.state.has_uncapped ? 999 : (data.scaling.maxLevel || base.maxLevel),
                xp:             data.scaling.xp             || 0,
                xp_needed:      data.scaling.xp_needed      || ((data.scaling.level||1) * 10),
                xp_percent:     data.scaling.xp_percent     || 0,
                uncapped:       this.state.has_uncapped     || data.scaling.uncapped || false,
                scaling_active: data.scaling.scaling_active ?? isActive
            };
        }
        return base;
    }

    // Build a clean perk object from raw data
    buildPerk(data) {
        const flags = Array.isArray(data.flags)
            ? data.flags.map(f => f.toUpperCase())
            : [];
        const scalingActive = flags.includes('SCALING')
            || flags.includes('UNCAPPED')
            || this.state.has_gamer
            || !!data.scaling?.scaling_active;
        return {
            name:               (data.name || 'Unknown').trim(),
            cost:               parseInt(data.cost) || 0,
            flags,
            description:        data.description || '',
            scaling_description:data.scaling_description || null,
            toggleable:         flags.includes('TOGGLEABLE'),
            active:             data.active !== false,
            scaling:            this.makeScaling(data, scalingActive),
            db_id:              data.db_id || null,
            acquired_at:        data.acquired_at || Date.now(),
            acquired_response:  data.acquired_response || this.state.response_count
        };
    }

    addPerk(data) {
        const name = (data.name || '').trim();
        if (!name) return { success: false, reason: 'no_name' };

        const flags = Array.isArray(data.flags) ? data.flags.map(f=>f.toUpperCase()) : [];

        // FIX: Removed name.toUpperCase().includes('UNCAPPED') — any perk with "uncapped"
        // in its name (e.g. "Uncapped Potential") would permanently fire the global modifier.
        // Flag-only check is the correct signal.
        if (flags.includes('UNCAPPED')) {
            this.applyUncapped();
        }
        if (flags.includes('GAMER') || flags.includes('META-SCALING')) {
            this.applyGamer();
        }

        const perk = this.buildPerk(data);

        if (this.state.has_gamer && perk.scaling && !perk.scaling.scaling_active) {
            perk.scaling.scaling_active = true;
        }
        if (this.state.has_uncapped && perk.scaling) {
            perk.scaling.maxLevel = 999;
            perk.scaling.uncapped = true;
        }

        const duplicate = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perk.name.toLowerCase()
        );
        if (duplicate) {
            this.log(`⚠️ Skipped duplicate: ${perk.name}`);
            return { success: false, reason: 'already_acquired', perk: duplicate };
        }

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

        if (flags.includes('UNCAPPED') && !this.state.has_uncapped) {
            this.applyUncapped();
        }
        if ((flags.includes('GAMER') || flags.includes('META-SCALING')) && !this.state.has_gamer) {
            this.applyGamer();
        }

        const scalingActive = flags.includes('SCALING')
            || flags.includes('UNCAPPED')
            || this.state.has_gamer
            || perk.scaling?.scaling_active
            || !!updates.scaling?.scaling_active;

        const mergedScalingData = {
            ...perk,
            scaling: {
                ...(perk.scaling || {}),
                ...(updates.scaling || {}),
                ...(updates.level !== undefined ? { level: parseInt(updates.level) || 1 } : {}),
                ...(updates.xp    !== undefined ? { xp:    parseInt(updates.xp)    || 0 } : {})
            }
        };

        this.state.acquired_perks[idx] = {
            ...perk,
            name:               updates.name        ?? perk.name,
            cost:               parseInt(updates.cost) || perk.cost,
            flags,
            description:        updates.description ?? perk.description,
            scaling_description: updates.scaling_description !== undefined
                ? (updates.scaling_description ?? perk.scaling_description)
                : perk.scaling_description,
            toggleable:          flags.includes('TOGGLEABLE'),
            active:              updates.active      ?? perk.active,
            scaling:             this.makeScaling(mergedScalingData, scalingActive)
        };

        this.recalcScalingPerk(this.state.acquired_perks[idx]);

        this.calcTotals();
        this.save();
        this.broadcast();
        this.log(`✏️ Perk edited: ${perk.name}`);

        const editedPerk = this.state.acquired_perks[idx];
        if (editedPerk?.db_id) {
            dbUpdatePerk(editedPerk.db_id, {
                name:               editedPerk.name,
                cost:               editedPerk.cost,
                flags:              editedPerk.flags,
                description:        editedPerk.description,
                scaling_description:editedPerk.scaling_description
            }).then(r => {
                if (r.success) this.log(`☁️ DB entry ${editedPerk.db_id} synced`);
                else this.log(`⚠️ DB sync skipped: ${r.reason}`);
            });
        }

        return { success: true };
    }

    removePerk(perkName) {
        const idx = this.state.acquired_perks.findIndex(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (idx === -1) return { success: false, reason: 'not_found' };
        this.state.acquired_perks.splice(idx, 1);
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

    checkBankAffordability() {
        if (!this.state.banked_perks?.length) return [];
        this.calcTotals();
        return this.state.banked_perks.filter(b => b.cost <= this.state.available_cp);
    }

    applyUncapped() {
        this.state.has_uncapped = true;
        for (const p of this.state.acquired_perks) {
            if (!p.scaling) {
                const active = this.state.has_gamer
                    || p.flags.includes('SCALING')
                    || p.flags.includes('UNCAPPED');
                p.scaling = this.makeScaling({}, active);
            }
            const shouldActivate = this.state.has_gamer
                || p.flags.includes('SCALING')
                || p.flags.includes('UNCAPPED');
            if (shouldActivate) p.scaling.scaling_active = true;

            p.scaling.maxLevel = 999;
            p.scaling.uncapped = true;
        }
        this.log('⚡ UNCAPPED active — level caps removed');
    }

    enablePerkScaling(perkName) {
        const perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return { success: false, reason: 'not_found' };
        if (perk.scaling) return { success: false, reason: 'already_scaling' };

        perk.flags = [...new Set([...perk.flags, 'SCALING'])];
        perk.scaling = this.makeScaling({});
        if (this.state.has_uncapped) {
            perk.scaling.maxLevel = 999;
            perk.scaling.uncapped = true;
        }
        this.save();
        this.broadcast();
        this.log(`📈 Scaling enabled for: ${perk.name}`);
        return { success: true };
    }

    enablePerkUncapped(perkName) {
        const perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return { success: false, reason: 'not_found' };

        if (!perk.scaling) {
            perk.flags = [...new Set([...perk.flags, 'SCALING'])];
            perk.scaling = this.makeScaling({});
        }

        if (perk.scaling.uncapped) return { success: false, reason: 'already_uncapped' };

        perk.scaling.maxLevel = 999;
        perk.scaling.uncapped = true;
        if (!perk.flags.includes('UNCAPPED')) perk.flags.push('UNCAPPED');
        this.save();
        this.broadcast();
        this.log(`∞ Uncapped enabled for: ${perk.name}`);
        return { success: true };
    }

    applyGamer() {
        this.state.has_gamer = true;
        for (const p of this.state.acquired_perks) {
            if (!p.scaling) {
                p.scaling = this.makeScaling({}, true);
            }
            p.scaling.scaling_active = true;
            if (this.state.has_uncapped) {
                p.scaling.maxLevel = 999;
                p.scaling.uncapped = true;
            }
        }
        this.log('🎮 GAMER active — all perks now gain XP and level');
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
        let perk = this.state.acquired_perks.find(p =>
            p.name.toLowerCase() === perkName.toLowerCase()
        );
        if (!perk) return null;

        if (!perk.scaling) {
            const active = this.state.has_gamer || perk.flags.includes('SCALING');
            perk.scaling = this.makeScaling({}, active);
        }

        if (!perk.scaling.scaling_active
            && !this.state.has_gamer
            && !perk.flags.includes('SCALING')) {
            return null;
        }
        if (this.state.has_gamer && !perk.scaling.scaling_active) {
            perk.scaling.scaling_active = true;
        }

        perk.scaling.xp += amount;
        this.log(`+${amount} XP → ${perk.name} (now ${perk.scaling.xp} XP)`);

        while (true) {
            const needed = perk.scaling.level * 10;
            if (perk.scaling.xp < needed) break;
            if (perk.scaling.level >= perk.scaling.maxLevel && !perk.scaling.uncapped) {
                perk.scaling.xp = needed;
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

        this.state.corruption = parsed.corruption;
        this.state.sanity     = parsed.sanity;

        for (const fp of parsed.perks) {
            const existing = this.state.acquired_perks.find(p =>
                p.name.toLowerCase() === fp.name.toLowerCase()
            );
            if (existing) {
                if (fp.scaling && existing.scaling) {
                    Object.assign(existing.scaling, fp.scaling);
                    this.recalcScalingPerk(existing);
                }
                if (fp.active !== undefined) existing.active = fp.active;
            } else {
                const activeRollName = (typeof cfrActiveRoll !== 'undefined' && cfrActiveRoll?.perk?.name || '').toLowerCase();
                const fpName         = (fp.name || '').toLowerCase();
                if (activeRollName && fpName === activeRollName) {
                    this.log(`⏸️ syncFromForge skipped ${fp.name} — active roll card pending player decision`);
                } else {
                    this.addPerk(fp);
                }
            }
        }

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

    parseNarrativeXP(text) {
        const patterns = [
            { re: /\*\*([^*]+?)\*\*\s+gains\s+(\d+)\s+XP/gi, ni: 1, xi: 2 },
            { re: /\+(\d+)\s+XP\s+to\s+\*\*([^*]+?)\*\*/gi, ni: 2, xi: 1 },
            { re: /\*\*([^*]+?)\*\*:\s*\+(\d+)\s+XP/gi,      ni: 1, xi: 2 }
        ];

        for (const { re, ni, xi } of patterns) {
            for (const m of text.matchAll(re)) {
                const perkName = m[ni].trim();
                const xp       = parseInt(m[xi]);
                this.addXP(perkName, xp);
            }
        }

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

        if (this.getSetting('auto_parse_forge')) {
            const parsed = this.parseForgeBlock(text);
            if (parsed) {
                this.syncFromForge(parsed);
                this.log('📦 Forge block synced');
            }
        }

        this.parseInlinePerks(text);
        this.parseNarrativeXP(text);
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
            const blob = JSON.stringify(this.state);
            localStorage.setItem(key, blob);
            localStorage.setItem(`cfr_profile_${typeof getActiveProfile === 'function' ? getActiveProfile() : 'default'}`, blob);
        } catch(e) { console.warn('[CFR] Save failed:', e); }
    }

    saveProfileOnly(profileName) {
        try {
            const blob = JSON.stringify(this.state);
            localStorage.setItem(`cfr_profile_${profileName || getActiveProfile?.() || 'default'}`, blob);
        } catch(e) { console.warn('[CFR] Profile save failed:', e); }
    }

    load() {
        try {
            const ctx = SillyTavern.getContext();
            let raw = ctx?.chatId
                ? localStorage.getItem(`cfr_${ctx.chatId}`)
                : null;
            if (!raw) {
                const profileKey = `cfr_profile_${getActiveProfile?.() || 'default'}`;
                raw = localStorage.getItem(profileKey);
            }
            if (!raw) raw = localStorage.getItem('cfr_global');
            if (raw) {
                this.state = { ...this.defaultState(), ...JSON.parse(raw) };
                this.calcTotals();
                if (this.state.acquired_perks?.length) {
                    console.log(`[CFR] Loaded ${this.state.acquired_perks.length} perks from localStorage`);
                }
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
        window.celestialForgeState = data;
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
const CFR_LEGACY_STATE    = 'cfr-character-state.json';

let cfrPerkDB       = null;
let cfrGistFileList = {};
let cfrProfileList  = [];

// ── Profile filename helpers ──────────────────────────────────

function getStateFilename(profileName) {
    return `cfr-state-${sanitizeProfileName(profileName)}.json`;
}

function sanitizeProfileName(name) {
    return (name || 'default')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 40) || 'default';
}

function getActiveProfile() {
    return cfrSettings?.active_profile || 'default';
}

function setActiveProfile(name) {
    if (!cfrSettings) return;
    cfrSettings.active_profile = sanitizeProfileName(name);
    cfrSaveDebounced?.();
    updateProfileUI();
    updateConstellationManagerList();
}

function listProfiles(gistData) {
    const files = Object.keys(gistData?.files || {});
    const profiles = files
        .filter(f => f.startsWith('cfr-state-') && f.endsWith('.json'))
        .map(f => f.replace('cfr-state-', '').replace('.json', ''));
    if (!profiles.includes('default')) profiles.unshift('default');
    return profiles;
}

function gistHeaders() {
    return {
        'Authorization': `token ${cfrSettings?.gist_pat || ''}`,
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json'
    };
}


// ── LOAD ─────────────────────────────────────────────────────

async function gistLoad(profileNameOverride) {
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

        cfrGistFileList = {};
        for (const [name, file] of Object.entries(data.files || {})) {
            cfrGistFileList[name] = file.raw_url;
        }

        cfrProfileList = listProfiles(data);
        updateProfileUI();

        if (cfrGistFileList[CFR_GIST_DB_FILE]) {
            const dbRes = await fetch(cfrGistFileList[CFR_GIST_DB_FILE]);
            cfrPerkDB   = await dbRes.json();
            if (!cfrPerkDB.custom_constellations) {
                cfrPerkDB.custom_constellations = {};
                console.log('[CFR] Migrated DB — custom_constellations added');
            }
        } else {
            cfrPerkDB = buildEmptyDB();
        }

        const targetProfile = sanitizeProfileName(profileNameOverride || getActiveProfile());
        const targetFile    = getStateFilename(targetProfile);

        let stateLoaded = false;

        if (cfrGistFileList[targetFile]) {
            const stRes  = await fetch(cfrGistFileList[targetFile]);
            const stData = await stRes.json();
            if (stData.state && cfrTracker) {
                cfrTracker.state = { ...cfrTracker.defaultState(), ...stData.state };
                cfrTracker.calcTotals();
                stateLoaded = true;
                console.log(`[CFR] ✅ Profile loaded: ${targetProfile}`);
            }
        }

        if (!stateLoaded && targetProfile === 'default' && cfrGistFileList[CFR_LEGACY_STATE]) {
            console.log('[CFR] Migrating legacy cfr-character-state.json → cfr-state-default.json');
            const stRes  = await fetch(cfrGistFileList[CFR_LEGACY_STATE]);
            const stData = await stRes.json();
            if (stData.state && cfrTracker) {
                cfrTracker.state = { ...cfrTracker.defaultState(), ...stData.state };
                cfrTracker.calcTotals();
                stateLoaded = true;
                await gistSaveState('default');
            }
        }

        if (!stateLoaded) {
            console.log(`[CFR] No saved state for profile '${targetProfile}' — starting fresh`);
        }

        if (profileNameOverride) setActiveProfile(profileNameOverride);
        refreshConstellationDropdowns();
        console.log('[CFR] ✅ Gist load complete');

    } catch(e) {
        console.error('[CFR] Gist load failed:', e);
        if (!cfrPerkDB) cfrPerkDB = buildEmptyDB();
    }
}


// ── SAVE STATE ───────────────────────────────────────────────

async function gistSaveState(profileNameOverride) {
    const id  = cfrSettings?.gist_id;
    const pat = cfrSettings?.gist_pat;
    if (!id || !pat || !cfrTracker) return;

    const profileName = sanitizeProfileName(profileNameOverride || getActiveProfile());
    const filename    = getStateFilename(profileName);

    try {
        await fetch(`https://api.github.com/gists/${id}`, {
            method:  'PATCH',
            headers: gistHeaders(),
            body:    JSON.stringify({
                files: {
                    [filename]: {
                        content: JSON.stringify({
                            version:      '1.0.1',
                            profile_name: profileName,
                            last_updated: new Date().toISOString(),
                            state:        cfrTracker.state
                        }, null, 2)
                    }
                }
            })
        });
        if (!cfrProfileList.includes(profileName)) {
            cfrProfileList.push(profileName);
            updateProfileUI();
        }
        try {
            localStorage.setItem(`cfr_profile_${profileName}`, JSON.stringify(cfrTracker.state));
        } catch(_) {}
        if (cfrSettings?.debug_mode) console.log(`[CFR] 📤 State saved: profile '${profileName}'`);
    } catch(e) {
        console.error('[CFR] Gist state save failed:', e);
    }
}


// ── SAVE DB ──────────────────────────────────────────────────

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


// ── PROFILE MANAGEMENT ───────────────────────────────────────

async function createProfile(name) {
    const clean = sanitizeProfileName(name);
    if (!clean) return { success: false, reason: 'invalid_name' };
    if (cfrProfileList.includes(clean)) return { success: false, reason: 'already_exists' };

    await gistSaveState(clean);
    setActiveProfile(clean);
    return { success: true, name: clean };
}

async function loadProfile(name) {
    const clean = sanitizeProfileName(name);
    await gistSaveState(getActiveProfile());
    await gistLoad(clean);
    setActiveProfile(clean);

    try {
        const profileKey = `cfr_profile_${clean}`;
        localStorage.setItem(profileKey, JSON.stringify(cfrTracker.state));
    } catch(e) {}

    updateTrackerUI();
    updateHUD();
    updatePromptInjection();
    return { success: true, name: clean };
}

async function duplicateProfile(fromName, toName) {
    const cleanFrom = sanitizeProfileName(fromName);
    const cleanTo   = sanitizeProfileName(toName);
    if (!cleanTo) return { success: false, reason: 'invalid_name' };

    const id  = cfrSettings?.gist_id;
    const pat = cfrSettings?.gist_pat;
    if (!id || !pat) return { success: false, reason: 'no_gist' };

    const sourceFile = getStateFilename(cleanFrom);
    const rawUrl     = cfrGistFileList[sourceFile];

    let stateContent;
    if (rawUrl) {
        const res  = await fetch(rawUrl);
        const data = await res.json();
        stateContent = {
            ...data,
            profile_name: cleanTo,
            last_updated: new Date().toISOString()
        };
    } else {
        stateContent = {
            version:      '1.0.1',
            profile_name: cleanTo,
            last_updated: new Date().toISOString(),
            state:        cfrTracker?.state || {}
        };
    }

    const destFile = getStateFilename(cleanTo);
    try {
        await fetch(`https://api.github.com/gists/${id}`, {
            method:  'PATCH',
            headers: gistHeaders(),
            body:    JSON.stringify({
                files: {
                    [destFile]: {
                        content: JSON.stringify(stateContent, null, 2)
                    }
                }
            })
        });
        if (!cfrProfileList.includes(cleanTo)) cfrProfileList.push(cleanTo);
        updateProfileUI();
        return { success: true, name: cleanTo };
    } catch(e) {
        console.error('[CFR] Duplicate profile failed:', e);
        return { success: false, reason: e.message };
    }
}

function removeProfileLocal(name) {
    const clean = sanitizeProfileName(name);
    if (clean === 'default') return { success: false, reason: 'cannot_remove_default' };
    cfrProfileList = cfrProfileList.filter(p => p !== clean);
    updateProfileUI();
    if (getActiveProfile() === clean) setActiveProfile('default');
    return { success: true };
}

// ── PROFILE UI ───────────────────────────────────────────────

function updateProfileUI() {
    const sel = document.getElementById('cfr-profile-select');
    if (!sel) return;

    const current = getActiveProfile();
    sel.innerHTML = cfrProfileList
        .map(p => `<option value="${p}" ${p === current ? 'selected' : ''}>${p}</option>`)
        .join('');

    const hudProfile = document.getElementById('cfr-hud-profile');
    if (hudProfile) hudProfile.textContent = current;
}

function getActiveConstellations() {
    const base   = { ...CFR_CONSTELLATIONS };
    const custom = cfrPerkDB?.custom_constellations || {};
    const merged = { ...base };
    for (const [key, data] of Object.entries(custom)) {
        merged[key] = data.label || key;
    }
    return merged;
}

function getConstellationCategory(key) {
    return cfrPerkDB?.custom_constellations?.[key]?.category || '';
}

function buildEmptyDB() {
    const constellations = {};
    for (const key of Object.keys(CFR_CONSTELLATIONS)) {
        constellations[key] = { domain: '', theme: '', perks: [] };
    }
    return {
        version:             '1.0.0',
        last_updated:        '',
        custom_constellations: {},
        constellations
    };
}

async function dbAddPerk(constellationKey, perkData) {
    if (!cfrPerkDB) cfrPerkDB = buildEmptyDB();
    if (!cfrPerkDB.constellations[constellationKey]) {
        cfrPerkDB.constellations[constellationKey] = { domain: '', theme: '', perks: [] };
    }

    const existing = cfrPerkDB.constellations[constellationKey].perks.find(p =>
        p.name.toLowerCase() === perkData.name.toLowerCase()
    );
    if (existing) return { success: false, reason: 'duplicate', existing };

    const tier    = cfrTierFromCost(perkData.cost);
    const newId   = `${constellationKey.toLowerCase()}_${Date.now()}`;
    cfrPerkDB.constellations[constellationKey].perks.push({
        id:                 newId,
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
    return { success: true, id: newId };
}

// ── AI GUIDE GENERATION ──────────────────────────────────────

async function generateConstellationGuide(key, label, category, sources) {
    const prompt = `You are defining the design space for a Celestial Forge perk constellation.

Celestial Forge is a jumpchain fanfiction concept where a protagonist randomly acquires crafting and technology abilities from fictional universes by accumulating Creation Points (CP). Perks belong to constellations (thematic domains) and have costs ranging from 50 CP (Tier 1 - Foundation) to 700+ CP (Tier 6 - Mythic).

Constellation to define:
NAME: ${label}
CATEGORY: ${category}${sources ? `\nSOURCES / DRAW FROM: ${sources}` : ''}

Write a concise domain guide covering:

DOMAIN OVERVIEW: What crafting, ability, or power space does this source material represent? What is the core fantasy of gaining abilities from it?

THEMATIC FLAVOR: What distinguishes perks from this constellation? What makes them feel authentic to the source? What tone — brutal, elegant, systematic, chaotic, esoteric?

TIER EXAMPLES (brief phrases, not full perk descriptions):
- Foundation (50-100 CP): basic exposure, entry-level techniques
- Journeyman (100-200 CP): functional competence, notable utility
- Expert (200-350 CP): signature techniques, recognizable abilities
- Master (350-500 CP): near-protagonist tier, rare specializations
- Transcendent (500-700 CP): top-tier canon abilities, game-changers
- Mythic (700+ CP): apex or unique abilities from peak characters

MECHANICAL NOTES: Key mechanics from the source that should shape perk design — resource systems (e.g. mana, cursed energy, nen), hard limitations, notable prerequisites, interesting synergies or failure modes.

FLAGS: Which of these flags are most thematically appropriate: PASSIVE, TOGGLEABLE, ALWAYS-ON, SCALING, UNCAPPED, CORRUPTING, SANITY-TAXING, COMBAT, UTILITY, CRAFTING, MENTAL, PHYSICAL, SELECTIVE?

AVOID GENERATING: Any perks that would be direct duplicates of abilities another constellation already covers generically. What makes THIS constellation distinct?

Write 350-450 words. Be specific and practical — this is a reference for future AI perk generation, not a summary for a reader unfamiliar with the source.`;

    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.generateQuietPrompt !== 'function') {
            throw new Error('generateQuietPrompt not available — upgrade SillyTavern');
        }
        const guide = await ctx.generateQuietPrompt(prompt, false, true);
        return guide?.trim() || null;
    } catch(e) {
        console.error('[CFR] Guide generation failed:', e);
        return null;
    }
}

window.cfrRegenerateGuide = async function(key) {
    const isBase = !!CFR_CONSTELLATIONS[key];
    const custom = isBase
        ? { label: CFR_CONSTELLATIONS[key], category: 'Core' }
        : cfrPerkDB?.custom_constellations?.[key];
    if (!custom) return;

    const statusEl = document.getElementById('cfr-const-status');
    if (statusEl) {
        statusEl.textContent = `⏳ Generating guide for "${custom.label}" via ST connection…`;
        statusEl.className   = 'cfr-status-msg ok';
    }

    const existingSources = CFR_CONSTELLATIONS[key]
        ? (cfrPerkDB?.constellations?.[key]?.sources || '')
        : (cfrPerkDB?.custom_constellations?.[key]?.sources || '');
    const guide = await generateConstellationGuide(key, custom.label, custom.category, existingSources);
    if (guide) {
        updateConstellationManagerList();

        const ta       = document.getElementById(`cfr-guide-ta-${key}`);
        const editorEl = document.getElementById(`cfr-guide-editor-${key}`);
        const saveBtn  = editorEl?.querySelector('button');

        if (ta) {
            ta.value = guide;
            if (editorEl) editorEl.style.display = 'block';
            if (saveBtn) {
                saveBtn.style.background    = 'rgba(241,196,15,0.25)';
                saveBtn.style.borderColor   = '#f1c40f';
                saveBtn.style.color         = '#f1c40f';
                saveBtn.textContent         = '💾 Confirm & Save to Gist';
            }
            if (statusEl) {
                statusEl.textContent = `✅ Guide ready — review below, edit if needed, then hit Confirm & Save`;
                statusEl.className   = 'cfr-status-msg ok';
            }
        } else {
            if (statusEl) {
                statusEl.textContent = '⚠️ Could not open editor — scroll to constellation and use 📝 to review';
                statusEl.className   = 'cfr-status-msg err';
            }
        }
    } else {
        if (statusEl) {
            statusEl.textContent = '⚠️ Generation failed — ST connection may be busy, try again or write guide manually';
            statusEl.className   = 'cfr-status-msg err';
        }
    }
};

window.cfrSaveGuide = async function(key) {
    const ta = document.getElementById(`cfr-guide-ta-${key}`);
    if (!ta || !cfrPerkDB) return;

    const guideText  = ta.value.trim();
    const isBase     = !!CFR_CONSTELLATIONS[key];
    let label        = '';

    const sourcesEl  = document.getElementById(`cfr-sources-ta-${key}`);
    const sourcesText = sourcesEl ? sourcesEl.value.trim() : null;

    if (isBase) {
        if (!cfrPerkDB.constellations) cfrPerkDB.constellations = {};
        if (!cfrPerkDB.constellations[key]) cfrPerkDB.constellations[key] = { domain: '', theme: '', perks: [] };
        cfrPerkDB.constellations[key].theme = guideText;
        if (sourcesText !== null) cfrPerkDB.constellations[key].sources = sourcesText;
        label = CFR_CONSTELLATIONS[key];
    } else {
        if (!cfrPerkDB.custom_constellations?.[key]) return;
        cfrPerkDB.custom_constellations[key].domain_guide = guideText;
        if (sourcesText !== null) cfrPerkDB.custom_constellations[key].sources = sourcesText;
        label = cfrPerkDB.custom_constellations[key].label;
    }

    await gistSaveDB();

    const editorEl = document.getElementById(`cfr-guide-editor-${key}`);
    const saveBtn  = editorEl?.querySelector('button');
    if (saveBtn) {
        saveBtn.style.background    = 'rgba(46,204,113,0.15)';
        saveBtn.style.borderColor   = '#2ecc71';
        saveBtn.style.color         = '#2ecc71';
        saveBtn.textContent         = '💾 Save Guide';
    }

    updateConstellationManagerList();

    const statusEl = document.getElementById('cfr-const-status');
    if (statusEl) {
        statusEl.textContent = `✅ Guide saved and synced to Gist for "${label}"`;
        statusEl.className   = 'cfr-status-msg ok';
    }
};

window.cfrToggleGuide = function(key) {
    const el = document.getElementById(`cfr-guide-editor-${key}`);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// ── PERK LEVEL DESCRIPTOR GENERATION ────────────────────────

async function generatePerkScalingDesc(perk) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.generateQuietPrompt !== 'function') return null;

    const isUncapped = perk.flags?.includes('UNCAPPED') || perk.scaling?.uncapped;
    const tier = perk.cost
        ? (perk.cost <= 100 ? 1 : perk.cost <= 200 ? 2 : perk.cost <= 350 ? 3 :
           perk.cost <= 500 ? 4 : perk.cost <= 700 ? 5 : 6)
        : 3;
    const tierLabel = CFR_TIER_LABELS[tier] || 'Expert';

    const prompt = `You are writing scaling tier descriptors for a Celestial Forge perk.

PERK: ${perk.name}
COST: ${perk.cost} CP (Tier ${tier} — ${tierLabel})
FLAGS: ${(perk.flags || []).join(', ') || 'none'}
DESCRIPTION: ${perk.description || '(no description)'}

Write concise scaling descriptors showing how this perk grows with mastery.
Each tier should feel meaningfully different — not just "better version of the same thing."
Ground each tier in specific capabilities, not vague power adjectives.

Respond ONLY with the scaling lines, no preamble, in EXACTLY this format:
1-3: [What the perk does at beginner mastery — specific, functional, grounded]
4-6: [Journeyman mastery — notable increase in scope, precision, or utility]
7-9: [Expert mastery — signature capability, recognizable as potent]
10: [Apex mastery — peak of what this perk can achieve within defined limits]`
        + (isUncapped ? '\nUNCAPPED: [Diminishing-returns behavior past level 10 — marginal refinement, not a new tier]' : '')
        + `

No headers, no explanation, no blank lines between tiers. Just the ` + (isUncapped ? 'five' : 'four') + ` lines.`;

    try {
        const result = await ctx.generateQuietPrompt(prompt, false, true);
        return result?.trim() || null;
    } catch(e) {
        console.error('[CFR] Scaling descriptor generation failed:', e);
        return null;
    }
}

async function dbAddConstellation(label, category) {
    if (!cfrPerkDB) cfrPerkDB = buildEmptyDB();
    if (!cfrPerkDB.custom_constellations) cfrPerkDB.custom_constellations = {};

    const key = label.trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 40);

    if (!key) return { success: false, reason: 'invalid_name' };
    if (CFR_CONSTELLATIONS[key] || cfrPerkDB.custom_constellations[key]) {
        return { success: false, reason: 'already_exists', key };
    }

    cfrPerkDB.custom_constellations[key] = {
        label:    label.trim(),
        category: category || 'Custom',
        created_at: new Date().toISOString()
    };
    if (!cfrPerkDB.constellations) cfrPerkDB.constellations = {};
    cfrPerkDB.constellations[key] = { domain: '', theme: '', perks: [] };

    await gistSaveDB();
    refreshConstellationDropdowns();

    {
        const statusEl = document.getElementById('cfr-const-status');
        if (statusEl) {
            statusEl.textContent = `⏳ Generating domain guide for "${label}" via ST connection…`;
            statusEl.className   = 'cfr-status-msg ok';
        }
        const newSources = cfrPerkDB?.custom_constellations?.[key]?.sources || '';
        generateConstellationGuide(key, label.trim(), category || 'Custom', newSources).then(guide => {
            if (guide && cfrPerkDB?.custom_constellations?.[key]) {
                updateConstellationManagerList();
                const ta       = document.getElementById(`cfr-guide-ta-${key}`);
                const editorEl = document.getElementById(`cfr-guide-editor-${key}`);
                const saveBtn  = editorEl?.querySelector('button');
                if (ta) {
                    ta.value = guide;
                    if (editorEl) editorEl.style.display = 'block';
                    if (saveBtn) {
                        saveBtn.style.background  = 'rgba(241,196,15,0.25)';
                        saveBtn.style.borderColor = '#f1c40f';
                        saveBtn.style.color       = '#f1c40f';
                        saveBtn.textContent       = '💾 Confirm & Save to Gist';
                    }
                    if (statusEl) statusEl.textContent = `✅ "${label}" added — guide ready below, review then Confirm & Save`;
                }
            } else if (statusEl) {
                statusEl.textContent = `✅ "${label}" added — ST connection unavailable, write guide manually via 📝`;
            }
        });
    }

    return { success: true, key };
}

async function dbRemoveConstellation(key) {
    if (CFR_CONSTELLATIONS[key]) {
        return { success: false, reason: 'cannot_remove_base' };
    }
    if (!cfrPerkDB?.custom_constellations?.[key]) {
        return { success: false, reason: 'not_found' };
    }

    const perkCount = cfrPerkDB.constellations?.[key]?.perks?.length || 0;
    delete cfrPerkDB.custom_constellations[key];

    await gistSaveDB();
    refreshConstellationDropdowns();
    return { success: true, perks_preserved: perkCount };
}

function refreshConstellationDropdowns() {
    const active = getActiveConstellations();

    const groups = { Core: [] };
    for (const [key, label] of Object.entries(CFR_CONSTELLATIONS)) {
        groups.Core.push({ key, label });
    }
    const custom = cfrPerkDB?.custom_constellations || {};
    for (const [key, data] of Object.entries(custom)) {
        const cat = data.category || 'Custom';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push({ key, label: data.label || key });
    }

    const buildOptions = (includeRandom, randomLabel) => {
        let html = includeRandom ? `<option value="">${randomLabel}</option>` : '';
        for (const [cat, items] of Object.entries(groups)) {
            if (!items.length) continue;
            html += `<optgroup label="${cat}">`;
            html += items.map(({key, label}) => `<option value="${key}">${label}</option>`).join('');
            html += `</optgroup>`;
        }
        return html;
    };

    const rollSel = document.getElementById('cfr-roll-constellation');
    if (rollSel) {
        const cur = rollSel.value;
        rollSel.innerHTML = buildOptions(true, '🎲 Random Constellation');
        if (cur) rollSel.value = cur;
    }

    updateConstellationManagerList();
}

function updateConstellationManagerList() {
    const el = document.getElementById('cfr-const-list');
    if (!el) return;

    const custom = cfrPerkDB?.custom_constellations || {};
    const base   = CFR_CONSTELLATIONS;

    function renderCard(k, label, meta, guideText, isBase) {
        const perkCount    = cfrPerkDB?.constellations?.[k]?.perks?.length || 0;
        const hasGuide     = !!guideText;
        const guidePreview = hasGuide
            ? guideText.slice(0, 80).replace(/</g, '&lt;') + '…'
            : 'No guide — hit 📝 to write or ⚡ to generate';
        const borderColor  = isBase ? '#3a3a5c' : '#e94560';
        const safeguide    = (guideText || '').replace(/</g, '&lt;').replace(/`/g, '\`');
        const rawSources   = isBase
            ? (cfrPerkDB?.constellations?.[k]?.sources || '')
            : (cfrPerkDB?.custom_constellations?.[k]?.sources || '');
        const safesources  = rawSources.replace(/</g, '&lt;').replace(/`/g, '\`');

        return `
        <div style="background:rgba(255,255,255,0.02);border-left:2px solid ${borderColor};border-radius:0 4px 4px 0;margin-bottom:5px;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:11px;color:${isBase ? '#aaa' : '#ddd'};font-weight:bold;">${label}</div>
                    <div style="font-size:9px;color:#444;">${meta} · ${perkCount} perk${perkCount !== 1 ? 's' : ''} · key: ${k}</div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0;margin-left:6px;">
                    <button onclick="cfrToggleGuide('${k}')" style="padding:2px 5px;background:rgba(52,152,219,0.1);border:1px solid #3498db44;border-radius:3px;color:#3498db;font-size:9px;cursor:pointer;">📝</button>
                    <button onclick="cfrRegenerateGuide('${k}')" style="padding:2px 5px;background:rgba(241,196,15,0.1);border:1px solid #f1c40f44;border-radius:3px;color:#f1c40f;font-size:9px;cursor:pointer;">⚡</button>
                    ${isBase ? '' : `<button onclick="cfrDeleteConstellation('${k}')" style="padding:2px 5px;background:rgba(231,76,60,0.1);border:1px solid #e74c3c44;border-radius:3px;color:#e74c3c;font-size:9px;cursor:pointer;">✕</button>`}
                </div>
            </div>
            <div style="padding:0 8px 4px;font-size:9px;color:#333;font-style:italic;">${guidePreview}</div>
            <div id="cfr-guide-editor-${k}" style="display:none;padding:6px 8px;border-top:1px solid #1a1a2e;">
                <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Domain Guide</div>
                <textarea id="cfr-guide-ta-${k}" style="width:100%;height:110px;background:#0a0a1a;border:1px solid #2a2a4e;border-radius:3px;color:#aaa;font-size:10px;padding:5px;box-sizing:border-box;resize:vertical;font-family:inherit;">${safeguide}</textarea>
                <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin:7px 0 3px;">Sources / Additional Context</div>
                <textarea id="cfr-sources-ta-${k}" placeholder="e.g. Overlord LN vols 1-14 — YGGDRASIL item crafting, Ainz's gear; or: this SB fic uses a point-buy system where..." style="width:100%;height:52px;background:#0a0a1a;border:1px solid #2a2a4e;border-radius:3px;color:#8a8aaa;font-size:10px;padding:5px;box-sizing:border-box;resize:vertical;font-family:inherit;">${safesources}</textarea>
                <div style="font-size:9px;color:#2a2a3e;font-style:italic;margin:3px 0 5px;line-height:1.3;">Feeds into perk generation and guide regeneration. Wiki links, arc names, specific characters, fic titles — directs the AI toward the right material.</div>
                <button onclick="cfrSaveGuide('${k}')" style="margin-top:2px;padding:3px 10px;background:rgba(46,204,113,0.15);border:1px solid #2ecc71;border-radius:3px;color:#2ecc71;font-size:10px;cursor:pointer;">💾 Save Guide &amp; Sources</button>
            </div>
        </div>`;
    }

    let html = '';

    const customKeys = Object.keys(custom);
    if (customKeys.length) {
        html += `<div style="font-size:10px;color:#e94560;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">Custom (${customKeys.length})</div>`;
        for (const [k, data] of Object.entries(custom)) {
            html += renderCard(k, data.label || k, data.category || 'Custom', data.domain_guide || '', false);
        }
    } else {
        html += `<div style="font-size:10px;color:#333;font-style:italic;padding:0 0 8px;">No custom constellations yet</div>`;
    }

    html += `
    <details style="margin-top:6px;">
        <summary style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;padding:3px 0;">
            <span style="color:#555;">▸</span> Core Constellations (${Object.keys(base).length}) — click to expand / edit guides
        </summary>
        <div style="margin-top:6px;">`;

    for (const [k, label] of Object.entries(base)) {
        const existingTheme = cfrPerkDB?.constellations?.[k]?.theme || '';
        html += renderCard(k, label, 'Core', existingTheme, true);
    }

    html += `</div></details>`;

    el.innerHTML = html;
}

async function dbUpdatePerk(dbId, updates) {
    if (!cfrPerkDB || !dbId) return { success: false, reason: 'no_db_or_id' };

    for (const [constKey, constData] of Object.entries(cfrPerkDB.constellations)) {
        const idx = constData.perks.findIndex(p => p.id === dbId);
        if (idx === -1) continue;

        const existing = constData.perks[idx];
        constData.perks[idx] = {
            ...existing,
            name:               updates.name               ?? existing.name,
            cost:               updates.cost               ?? existing.cost,
            tier:               updates.cost ? cfrTierFromCost(updates.cost) : existing.tier,
            tier_label:         updates.cost ? (CFR_TIER_LABELS[cfrTierFromCost(updates.cost)] || '') : existing.tier_label,
            flags:              updates.flags               ?? existing.flags,
            description:        updates.description         ?? existing.description,
            scaling_description:updates.scaling_description ?? existing.scaling_description,
            updated_at:         new Date().toISOString()
        };

        await gistSaveDB();
        return { success: true, constellation: constKey };
    }
    return { success: false, reason: 'id_not_found' };
}

// FIX: Returns a shallow copy — protects live DB object from downstream mutation
function dbRollPerk(constellationKey) {
    const list = cfrPerkDB?.constellations?.[constellationKey]?.perks || [];
    if (!list.length) return null;
    const idx = Math.floor(Math.random() * list.length);
    list[idx].times_rolled = (list[idx].times_rolled || 0) + 1;
    gistSaveDB();
    return { ...list[idx] };
}

function dbRandomConstellation() {
    const keys = Object.keys(getActiveConstellations());
    return keys[Math.floor(Math.random() * keys.length)];
}


// ============================================================
//  ROLL SYSTEM
// ============================================================

let cfrActiveRoll = null;

function cfrGetAwaiting() {
    return sessionStorage.getItem('cfr_awaiting_creation') === 'true';
}
function cfrSetAwaiting(val, constellation) {
    if (val) {
        sessionStorage.setItem('cfr_awaiting_creation', 'true');
        if (constellation) sessionStorage.setItem('cfr_creation_const', constellation);
    } else {
        sessionStorage.removeItem('cfr_awaiting_creation');
    }
}
function cfrGetConstellation() {
    return sessionStorage.getItem('cfr_creation_const') || null;
}
let cfrAwaitingCreation = false;
let cfrCreationConstellation = null;

// FIX: Calls calcTotals() first so available_cp is never stale
function buildCreationPrompt(constellationKey, tier) {
    cfrTracker?.calcTotals();

    const constData = cfrPerkDB?.constellations?.[constellationKey];
    const label     = getActiveConstellations()[constellationKey] || constellationKey;
    const customEntry = cfrPerkDB?.custom_constellations?.[constellationKey];
    const theme       = customEntry?.domain_guide || constData?.theme || '';
    const sources     = customEntry?.sources      || constData?.sources || '';
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
DOMAIN THEME: ${theme || '(no guide set — use constellation name and category to infer appropriate ability space)'}${sources ? `\nADDITIONAL SOURCES / CONTEXT: ${sources}` : ''}
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

If the perk ALSO has the UNCAPPED flag, add one additional line after the SCALING section:
UNCAPPED: [Describe the diminishing-returns behavior past level 10. What does each additional level refine or extend? This should describe marginal improvement philosophy, not a new tier — e.g. "Each level beyond apex sharpens precision rather than expanding range, narrowing the margin of error toward theoretical perfection" or "Further levels push the upper boundary of effect by roughly 5-10% per level, approaching but never quite reaching an absolute limit."]

Do NOT duplicate existing ${label} perks: ${existing}

After the perk, output an updated forge block with the perk in pending_perk (unaffordable) or perks array (affordable).
[END CREATION ROLL]`;
}

async function triggerForgeRoll(constellationKey) {
    if (!cfrPerkDB) await gistLoad();

    const key   = constellationKey || dbRandomConstellation();
    const label = getActiveConstellations()[key] || key;
    const perk  = dbRollPerk(key);

    if (!perk) {
        showRollResult(null, key, label, 'forge');
        return;
    }

    cfrActiveRoll = { type: 'forge', perk, constellationKey: key, constellationLabel: label };
    showRollResult(perk, key, label, 'forge');
}

async function triggerCreationRoll(constellationKey, tier) {
    if (!cfrPerkDB) await gistLoad();

    const key   = constellationKey || dbRandomConstellation();
    const label = getActiveConstellations()[key] || key;
    const t     = tier || Math.ceil(Math.random() * 4) + 1;

    cfrCreationConstellation = key;
    cfrAwaitingCreation      = true;
    cfrSetAwaiting(true, key);

    const prompt = buildCreationPrompt(key, t);

    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('cfr-creation-roll', prompt, 0, 0);
        }
    } catch(e) { console.warn('[CFR] Creation prompt inject failed:', e); }

    showCreationPending(key, label, t);
}

async function finalizeCreationRoll(text) {
    const isAwaiting = cfrAwaitingCreation || cfrGetAwaiting();
    if (!isAwaiting) return;

    if (!cfrCreationConstellation) {
        cfrCreationConstellation = cfrGetConstellation();
    }

    let perk = null;

    const matchDirect = text.match(/^\*\*\[?([^*:\n\[\]]+?)\]?\*\*\s*\((\d+)\s*CP\)\s*\[([^\]]*)\]/m);
    if (matchDirect) {
        perk = parsePerkFromMatch(matchDirect, text);
        console.log('[CFR] Parsed perk via Strategy 1 (direct format)');
    }

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
        console.warn('[CFR] Creation roll: all parse strategies failed — keeping await flag for continuation.');
        showRollToast('Perk not parsed yet — if AI is still generating, it will be caught on continuation', false);
        return;
    }

    cfrAwaitingCreation = false;
    cfrSetAwaiting(false);
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('cfr-creation-roll', '', 0, 0);
        }
    } catch(e) {}

    cfrActiveRoll = {
        type:               'creation',
        perk,
        constellationKey:   cfrCreationConstellation,
        constellationLabel: getActiveConstellations()[cfrCreationConstellation] || cfrCreationConstellation
    };

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
    const rawName = match[1].trim();
    const cleanName = rawName.replace(/^\[|\]$/g, '').trim();
    return {
        name:               cleanName,
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
    const scalingIdx = withoutForge.search(/^SCALING:/m);
    const descText   = scalingIdx > -1 ? withoutForge.slice(0, scalingIdx).trim() : withoutForge;
    const paragraphs = descText.split(/\n\n+/).filter(p => p.trim().length > 20).slice(0, 3);
    return paragraphs.join('\n\n').trim();
}

function extractDescriptionFromText(text, perkName) {
    const nameIdx = text.toLowerCase().indexOf(perkName.toLowerCase());
    if (nameIdx === -1) return '';
    const after    = text.slice(nameIdx + perkName.length);
    const cleaned  = after.replace(/```forge[\s\S]*?```/g, '').trim();
    const paragraphs = cleaned.split(/\n\n+/).filter(p => p.trim().length > 20).slice(0, 3);
    return paragraphs.join('\n\n').trim();
}

// FIX: Sorts tier keys numerically so output is always 1-3, 4-6, 7-9, 10, UNCAPPED
function scalingDescToText(sd) {
    if (!sd || typeof sd !== 'object') return '';
    const lines = [];
    const sorted = Object.entries(sd)
        .filter(([key]) => key !== 'uncapped')
        .sort(([a], [b]) => {
            const aNum = parseInt(a.split('-')[0]) || 0;
            const bNum = parseInt(b.split('-')[0]) || 0;
            return aNum - bNum;
        });
    for (const [key, val] of sorted) {
        lines.push(`${key}: ${val}`);
    }
    if (sd['uncapped']) lines.push(`UNCAPPED: ${sd['uncapped']}`);
    return lines.join('\n');
}

// FIX: Changed \n\n\n to \n\n+ — standard AI output uses two newlines between sections
function extractScalingDescription(text) {
    const scalingMatch = text.match(/\*{0,2}SCALING:\*{0,2}\s*\n([\s\S]*?)(?=\n\n+|```forge|\[END|$)/);
    if (!scalingMatch) return null;

    const lines  = scalingMatch[1].split('\n').filter(l => l.trim());
    const result = {};
    for (const line of lines) {
        const m = line.match(/^\*{0,2}(\d+(?:-\d+)?):\*{0,2}\s*(.+)/);
        if (m) {
            const key = m[1].trim();
            const val = m[2].replace(/^\*+|\*+$/g, '').trim();
            result[key] = val;
        }
    }

    const uncappedMatch = text.match(/^\*{0,2}UNCAPPED:\*{0,2}\s*(.+)/m);
    if (uncappedMatch) {
        result['uncapped'] = uncappedMatch[1].replace(/^\*+|\*+$/g, '').trim();
    }

    return Object.keys(result).length ? result : null;
}

async function rollAcquire() {
    if (!cfrActiveRoll) return;
    const { perk, constellationKey, type } = cfrActiveRoll;

    const dbResult = await dbAddPerk(constellationKey, { ...perk, source: type });
    const dbId = dbResult.id || dbResult.existing?.id || null;
    const perkWithId = { ...perk, db_id: dbId };

    const result = cfrTracker.addPerk(perkWithId);

    if (!result.success && result.reason === 'already_acquired') {
        showRollToast(`✅ ${perk.name} already on sheet — DB updated`);
        cfrActiveRoll = null;
        hideRollCard();
        checkAndNotifyBank();
        return;
    }

    if (!result.success && result.reason === 'insufficient_cp') {
        cfrTracker.bankPerk(perkWithId, constellationKey);
        showRollToast(`💡 Can't afford yet — ${perk.name} banked automatically`);
    } else {
        showRollToast(`✅ ${perk.name} acquired!`);
    }

    cfrActiveRoll = null;
    hideRollCard();
    checkAndNotifyBank();
}

async function rollBank() {
    if (!cfrActiveRoll) return;
    const { perk, constellationKey, type } = cfrActiveRoll;

    const dbResult = await dbAddPerk(constellationKey, { ...perk, source: type });
    const dbId     = dbResult.id || dbResult.existing?.id || null;
    const perkWithId = { ...perk, db_id: dbId };

    const result = cfrTracker.bankPerk(perkWithId, constellationKey);
    if (result.success) {
        showRollToast(`🏦 ${perk.name} banked (${(cfrTracker.state.banked_perks||[]).length}/${cfrSettings?.bank_max||10} slots)`);
    } else {
        showRollToast(`⚠️ Bank full (${result.max} slots max) — discard something first`, true);
    }

    cfrActiveRoll = null;
    hideRollCard();
}

function rollDiscard() {
    if (!cfrActiveRoll) return;
    const name = cfrActiveRoll.perk?.name || 'perk';
    cfrActiveRoll = null;
    hideRollCard();
    showRollToast(`❌ ${name} discarded — no CP spent`);
}

function checkAndNotifyBank() {
    if (!cfrTracker) return;
    const affordable = cfrTracker.checkBankAffordability();
    if (!affordable.length) return;
    const p = affordable[0];
    showBankNotification(p);
}


// ============================================================
//  ROLL UI (injected into HUD)
// ============================================================

function getRollPanelHTML() {
    const active = getActiveConstellations();
    const constellationOptions = Object.entries(active)
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
  <div style="display:flex;gap:6px;margin-top:5px;">
    <button id="cfr-btn-scan-last" style="flex:1;padding:5px 4px;background:rgba(52,152,219,0.12);border:1px solid #3498db;border-radius:4px;color:#3498db;font-size:11px;cursor:pointer;">🔍 Scan Last Message</button>
    <button id="cfr-btn-scan-forge" style="flex:1;padding:5px 4px;background:rgba(46,204,113,0.1);border:1px solid #2ecc71;border-radius:4px;color:#2ecc71;font-size:11px;cursor:pointer;">⚙ Apply Forge Block</button>
  </div>
  <div style="display:flex;gap:6px;margin-top:5px;">
    <button id="cfr-btn-stamp-forge" style="flex:1;padding:5px 4px;background:rgba(155,89,182,0.12);border:1px solid #9b59b6;border-radius:4px;color:#9b59b6;font-size:11px;cursor:pointer;">📋 Stamp to Chat</button>
    <button id="cfr-btn-force-sync" style="flex:1;padding:5px 4px;background:rgba(230,126,34,0.12);border:1px solid #e67e22;border-radius:4px;color:#e67e22;font-size:11px;cursor:pointer;">⚡ Sync AI Context</button>
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
                ${affordable
                    ? `<button onclick="cfrTracker.acquireBanked('${b.name}');updateBankedList();updateHUD();updatePromptInjection();" style="padding:2px 6px;background:rgba(46,204,113,0.15);border:1px solid #2ecc71;border-radius:3px;color:#2ecc71;font-size:9px;cursor:pointer;">Purchase</button>`
                    : `<button disabled title="Need ${b.cost - (cfrTracker?.state?.available_cp||0)} more CP" style="padding:2px 6px;background:rgba(100,100,100,0.08);border:1px solid #333;border-radius:3px;color:#444;font-size:9px;cursor:not-allowed;">Purchase</button>
                       <span style="font-size:9px;color:#555;">-${b.cost - (cfrTracker?.state?.available_cp||0)} CP</span>`
                }
                <button onclick="cfrTracker.discardBanked('${b.name}');updateBankedList();" style="padding:2px 6px;background:rgba(231,76,60,0.1);border:1px solid #e74c3c33;border-radius:3px;color:#e74c3c;font-size:9px;cursor:pointer;">✕</button>
              </span>
            </div>`;
    }).join('');
}

async function scanLastMessage() {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) {
        showRollToast('No messages in chat yet', true);
        return;
    }

    let targetIdx = -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { targetIdx = i; break; }
    }

    if (targetIdx === -1) {
        showRollToast('No AI messages found', true);
        return;
    }

    const raw = ctx.chat[targetIdx].mes;
    if (!raw) {
        showRollToast('Last AI message is empty', true);
        return;
    }

    showRollToast('🔍 Scanning last message…');
    console.log('[CFR] Manual scan — message idx', targetIdx, 'length', raw.length);

    const isAwaiting = cfrAwaitingCreation || cfrGetAwaiting();
    if (isAwaiting) {
        await finalizeCreationRoll(raw);
    } else {
        passivePerkScan(raw);
    }

    cfrLastMsgIdx = targetIdx;
    cfrTracker.processResponse(raw);

    updateTrackerUI();
    updateHUD();
    updatePromptInjection();
}

// FIX: Now correctly parses the forge block before passing to syncFromForge.
// The original code passed raw string directly to syncFromForge which expected
// a parsed object, silently crashing with a TypeError on parsed.perks iteration.
function applyLastForgeBlock() {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) {
        showRollToast('No messages in chat yet', true);
        return;
    }

    let raw = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user && ctx.chat[i].mes?.includes('```forge')) {
            raw = ctx.chat[i].mes;
            break;
        }
    }

    if (!raw) {
        showRollToast('No forge block found in recent messages', true);
        return;
    }

    const parsed = cfrTracker.parseForgeBlock(raw);
    if (!parsed) {
        showRollToast('⚠️ Forge block found but could not parse JSON — check AI output format', true);
        return;
    }

    cfrTracker.syncFromForge(parsed);
    updateTrackerUI();
    updateHUD();
    updatePromptInjection();
    showRollToast('✅ Forge block applied — state updated');
}

window.scanLastMessage    = scanLastMessage;
window.applyLastForgeBlock = applyLastForgeBlock;

// FIX: Uses matchAll to iterate all perk headers; surfaces first unacquired perk.
// Original only caught the first match in the entire text regardless of acquisition status.
function passivePerkScan(text) {
    const re = /^\*\*\[?([^*:\n\[\]]+?)\]?\*\*\s*\((\d+)\s*CP\)\s*\[([^\]]*)\]/gm;
    for (const match of text.matchAll(re)) {
        const name  = match[1].trim();
        const cost  = parseInt(match[2]);
        const flags = match[3].split(/[,\s]+/).map(f => f.trim()).filter(Boolean);

        const already = cfrTracker?.state?.acquired_perks?.some(p =>
            p.name.toLowerCase() === name.toLowerCase()
        );
        if (already) continue;

        console.log('[CFR] Passive scan found perk:', name, cost, flags);

        const perk = {
            name, cost, flags,
            description: extractDescriptionFromText(text, name),
            scaling_description: extractScalingDescription(text),
            source: 'detected'
        };
        cfrActiveRoll = {
            type: 'creation',
            perk,
            constellationKey:   cfrCreationConstellation || '',
            constellationLabel: getActiveConstellations()[cfrCreationConstellation] || 'Unknown Constellation'
        };

        const hud = document.getElementById('cfr-hud');
        const btn = document.getElementById('cfr-hud-btn');
        if (hud && hud.classList.contains('hidden')) {
            hud.classList.remove('hidden');
            if (btn) btn.classList.add('open');
        }
        showRollResult(perk, cfrActiveRoll.constellationKey, cfrActiveRoll.constellationLabel, 'creation');
        showRollToast('Perk detected in response — choose Acquire, Bank, or Discard');
        return; // surface one at a time — player resolves each before next fires
    }
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

    $('#cfr-btn-scan-last').on('click', () => scanLastMessage());
    $('#cfr-btn-scan-forge').on('click', () => applyLastForgeBlock());
    $('#cfr-btn-stamp-forge').on('click', () => stampForgeBlock());
    $('#cfr-btn-force-sync').on('click', () => forceSyncPrompt());

    $('#cfr-btn-apply-gamer').on('click', () => {
        if (!cfrTracker) return;
        if (cfrTracker.state.has_gamer) {
            showStatus('cfr-global-mod-status', '🎮 GAMER already active', 'ok');
            return;
        }
        cfrTracker.applyGamer();
        cfrTracker.save();
        cfrTracker.broadcast();
        updateTrackerUI();
        updateHUD();
        updateGlobalModStatus();
        updatePromptInjection();
        showStatus('cfr-global-mod-status', '✅ GAMER activated — all perks now scale', 'ok');
    });

    $('#cfr-btn-apply-uncapped').on('click', () => {
        if (!cfrTracker) return;
        if (cfrTracker.state.has_uncapped) {
            showStatus('cfr-global-mod-status', '⚡ UNCAPPED already active', 'ok');
            return;
        }
        cfrTracker.applyUncapped();
        cfrTracker.save();
        cfrTracker.broadcast();
        updateTrackerUI();
        updateHUD();
        updateGlobalModStatus();
        updatePromptInjection();
        showStatus('cfr-global-mod-status', '✅ UNCAPPED activated — all scaling perks unlimited', 'ok');
    });

    $('#cfr-btn-const-add').on('click', async () => {
        const name = $('#cfr-const-name-input').val().trim();
        const cat  = $('#cfr-const-cat-select').val();
        if (!name) {
            showStatus('cfr-const-status', '⚠️ Enter a constellation name', 'err');
            return;
        }
        showStatus('cfr-const-status', '➕ Adding…', 'ok');
        const result = await dbAddConstellation(name, cat);
        if (result.success) {
            $('#cfr-const-name-input').val('');
            showStatus('cfr-const-status', `✅ "${name}" added (key: ${result.key})`, 'ok');
        } else if (result.reason === 'already_exists') {
            showStatus('cfr-const-status', `⚠️ Already exists as ${result.key}`, 'err');
        } else {
            showStatus('cfr-const-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    $('#cfr-btn-profile-load').on('click', async () => {
        const sel = $('#cfr-profile-select').val();
        if (!sel) return;
        if (!confirm(`Load profile "${sel}"? Unsaved changes to "${getActiveProfile()}" will be saved first.`)) return;
        showStatus('cfr-profile-status', '📂 Loading…', 'ok');
        await loadProfile(sel);
        showStatus('cfr-profile-status', `✅ Profile "${sel}" loaded`, 'ok');
    });

    $('#cfr-btn-profile-save').on('click', async () => {
        const active = getActiveProfile();
        showStatus('cfr-profile-status', '💾 Saving…', 'ok');
        await gistSaveState(active);
        showStatus('cfr-profile-status', `✅ Profile "${active}" saved`, 'ok');
    });

    $('#cfr-btn-profile-new').on('click', async () => {
        const name = $('#cfr-profile-name-input').val().trim();
        if (!name) {
            showStatus('cfr-profile-status', '⚠️ Enter a name for the new profile', 'err');
            return;
        }
        showStatus('cfr-profile-status', '➕ Creating…', 'ok');
        const result = await createProfile(name);
        if (result.success) {
            $('#cfr-profile-name-input').val('');
            showStatus('cfr-profile-status', `✅ Profile "${result.name}" created and activated`, 'ok');
        } else if (result.reason === 'already_exists') {
            showStatus('cfr-profile-status', `⚠️ Profile "${result.name}" already exists — use Duplicate or pick a different name`, 'err');
        } else {
            showStatus('cfr-profile-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    $('#cfr-btn-profile-dupe').on('click', async () => {
        const toName = $('#cfr-profile-name-input').val().trim();
        if (!toName) {
            showStatus('cfr-profile-status', '⚠️ Enter a name for the duplicate', 'err');
            return;
        }
        const fromName = getActiveProfile();
        showStatus('cfr-profile-status', `📋 Duplicating "${fromName}"…`, 'ok');
        const result = await duplicateProfile(fromName, toName);
        if (result.success) {
            $('#cfr-profile-name-input').val('');
            showStatus('cfr-profile-status', `✅ "${fromName}" duplicated as "${result.name}" — switch to it via the selector`, 'ok');
        } else {
            showStatus('cfr-profile-status', `⚠️ Duplicate failed: ${result.reason}`, 'err');
        }
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

window.rollAcquire = rollAcquire;
window.rollBank    = rollBank;
window.rollDiscard = rollDiscard;


// ============================================================
//  PROMPT INJECTION
// ============================================================

const CFR_PROMPT_KEY = 'celestial-forge-reformed-state';

function updatePromptInjection() {
    if (!cfrTracker) return;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt !== 'function') {
            if (!window._cfrPromptWarnShown) {
                console.warn('[CFR] setExtensionPrompt not available — upgrade SillyTavern for prompt injection.');
                window._cfrPromptWarnShown = true;
            }
            return;
        }

        if (!cfrSettings?.enabled) {
            ctx.setExtensionPrompt(CFR_PROMPT_KEY, '', 0, 0);
            return;
        }

        const block = buildPromptBlock();
        ctx.setExtensionPrompt(CFR_PROMPT_KEY, block, 0, 0);

        if (cfrSettings?.debug_mode) {
            console.log('[CFR] 📤 Prompt injection updated');
        }
    } catch(e) {
        console.warn('[CFR] Prompt injection failed:', e);
    }
}

function getCurrentScalingDesc(perk) {
    const sd = perk.scaling_description;
    if (!sd || typeof sd !== 'object') return null;
    const level = perk.scaling?.level || 1;

    if (sd[String(level)]) return sd[String(level)];

    for (const [key, val] of Object.entries(sd)) {
        const rangeMatch = key.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1]);
            const hi = parseInt(rangeMatch[2]);
            if (level >= lo && level <= hi) return val;
        }
    }

    if (sd['uncapped']) {
        if (perk.scaling?.uncapped && level > 10) {
            const levelsOver = level - 10;
            return `[Level ${level} — ${levelsOver} beyond apex] ` + sd['uncapped'];
        }
    }

    const keys = Object.keys(sd)
        .filter(k => k !== 'uncapped')
        .sort((a, b) => {
            const aNum = parseInt(a.split('-').pop());
            const bNum = parseInt(b.split('-').pop());
            return aNum - bNum;
        });

    if (keys.length && perk.scaling?.uncapped && level > 10) {
        const levelsOver = level - 10;
        return `[Level ${level} — ${levelsOver} beyond apex] ` + sd[keys[keys.length - 1]];
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

            const currentDesc = getCurrentScalingDesc(p);
            if (currentDesc) {
                entry += `\n    Current effect: ${currentDesc}`;
            } else if (p.description) {
                entry += `\n    Effect: ${p.description}`;
            }

            if (p.scaling?.uncapped && p.scaling?.level > 10 && p.scaling_description?.uncapped) {
                entry += `\n    Beyond-apex behavior: ${p.scaling_description.uncapped}`;
            }

            lines.push(entry);
        }
    }

    if (s.pending_perk) {
        lines.push(`Pending (unaffordable): ${s.pending_perk.name} (${s.pending_perk.cost} CP — ${s.pending_perk.cp_needed} CP short)`);
    }

    lines.push('[END FORGE STATE]');

    lines.push('');
    lines.push('MANDATORY: End EVERY response with an updated forge block in this exact format:');
    lines.push('```forge');
    lines.push('{');
    lines.push('  "characters": [{');
    lines.push('    "characterName": "<name>",');
    lines.push('    "currentDateTime": "<in-world date and time>",');
    lines.push('    "stats": {');
    lines.push('      "total_cp": <number>,');
    lines.push('      "available_cp": <number>,');
    lines.push('      "threshold_progress": <0-100>,');
    lines.push('      "threshold_max": 100,');
    lines.push('      "threshold_percent": <0-100>,');
    lines.push('      "corruption": <0-100>,');
    lines.push('      "sanity": <0-100>,');
    lines.push('      "perk_count": <number>,');
    lines.push('      "perks": [ <current acquired perks array — update xp/level if XP was earned> ],');
    lines.push('      "pending_perk": "",');
    lines.push('      "pending_cp": 0,');
    lines.push('      "pending_remaining": 0');
    lines.push('    }');
    lines.push('  }]');
    lines.push('}');
    lines.push('```');
    lines.push('Rules: update threshold_progress by +10 each response. Update perk xp/level if XP lines appear in narrative. Do NOT omit this block — it is required for system tracking.');

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
      <b>⚒️ Celestial Forge Reformed v1.0.1</b>
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
              <div id="cfr-scaling-dormant-note" style="display:none;font-size:10px;color:#f1c40f;background:rgba(241,196,15,0.08);border:1px solid #f1c40f33;border-radius:3px;padding:4px 7px;margin-bottom:5px;">Dormant scaffold — values saved, active once SCALING flag added or GAMER unlocks</div>
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
            <!-- Scaling tier descriptors -->
            <div id="cfr-edit-scaling-desc-section" style="display:none;margin-top:8px;">
              <div style="font-size:10px;color:#2ecc71;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Level Descriptors</div>
              <div id="cfr-scaling-desc-missing" style="display:none;font-size:10px;color:#f1c40f;background:rgba(241,196,15,0.07);border:1px solid #f1c40f33;border-radius:3px;padding:4px 7px;margin-bottom:5px;">No level descriptors yet — the AI won't know what each level feels like for this perk.</div>
              <textarea id="cfr-edit-scaling-desc" placeholder="1-3: Basic control...
4-6: Refined technique...
7-9: Expert mastery...
10: Apex capability...
UNCAPPED: Marginal refinement per level..." style="width:100%;height:90px;background:#0a0a1a;border:1px solid #2a2a4e;border-radius:3px;color:#aaa;font-size:10px;padding:5px;box-sizing:border-box;resize:vertical;font-family:monospace;"></textarea>
              <div class="cfr-btn-row" style="margin-top:4px;">
                <input type="button" class="menu_button" id="cfr-btn-gen-scaling-desc" value="✨ Generate Level Descriptors" />
              </div>
              <div id="cfr-scaling-desc-status" class="cfr-status-msg" style="margin-top:4px;"></div>
            </div>
            <div class="cfr-btn-row" style="margin-top:8px;">
              <input type="button" class="menu_button" id="cfr-btn-save-edit" value="💾 Save Changes" />
            </div>
            <div id="cfr-post-save-gen-prompt" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(241,196,15,0.07);border:1px solid #f1c40f44;border-radius:4px;">
              <div style="font-size:10px;color:#f1c40f;margin-bottom:5px;">This perk has no level descriptors. Generate them now?</div>
              <div style="display:flex;gap:5px;">
                <button id="cfr-post-save-yes" style="flex:1;padding:3px 0;background:rgba(46,204,113,0.15);border:1px solid #2ecc71;border-radius:3px;color:#2ecc71;font-size:10px;cursor:pointer;">✨ Generate</button>
                <button id="cfr-post-save-no" style="flex:1;padding:3px 0;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#555;font-size:10px;cursor:pointer;">Not now</button>
              </div>
            </div>
            <div style="border-top:1px solid #1a1a2e;margin-top:10px;padding-top:8px;">
              <div style="font-size:10px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Per-Perk Overrides</div>
              <div style="font-size:10px;color:#555;margin-bottom:7px;line-height:1.4;">
                Apply scaling/uncapped to this perk only — does not activate global flags.
              </div>
              <div class="cfr-btn-row" style="margin-bottom:5px;">
                <input type="button" class="menu_button" id="cfr-btn-perk-scale" value="📈 Enable Scaling" />
                <span id="cfr-perk-scale-status" style="font-size:10px;color:#555;margin-left:4px;"></span>
              </div>
              <div class="cfr-btn-row">
                <input type="button" class="menu_button" id="cfr-btn-perk-uncap" value="∞ Remove Level Cap" />
                <span id="cfr-perk-uncap-status" style="font-size:10px;color:#555;margin-left:4px;"></span>
              </div>
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
            <input type="button" class="menu_button" id="cfr-btn-gist-save" value="💾 Save Credentials" />
          </div>
          <div class="cfr-btn-row" style="margin-top:4px;">
            <input type="button" class="menu_button" id="cfr-btn-gist-push" value="⬆ Push to Gist" />
            <input type="button" class="menu_button" id="cfr-btn-gist-pull" value="⬇ Pull from Gist" />
          </div>
          <div id="cfr-gist-status" class="cfr-status-msg"></div>
        </div>
      </div>

      <!-- GLOBAL MODIFIERS -->
      <!-- FIX: Removed "active" from static label text — it was always displaying
           as "UNCAPPED active" / "GAMER active" regardless of actual state.
           The dynamic status span beside it now carries the active/inactive text. -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">⚡ Global Modifiers</div>
        <div class="cfr-settings-section">
          <div style="font-size:11px;color:#888;margin-bottom:6px;line-height:1.4;">
            Use these when a perk's <em>effect</em> grants GAMER or UNCAPPED globally,
            but the perk itself isn't flagged with those. Fires retroactively on all current perks.
          </div>
          <div id="cfr-global-mod-status" style="font-size:11px;margin-bottom:6px;"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <span style="font-size:12px;color:#ccc;">🎮 GAMER</span>
            <span id="cfr-gamer-status" style="font-size:11px;color:#555;">inactive</span>
          </div>
          <div class="cfr-btn-row" style="margin-bottom:8px;">
            <input type="button" class="menu_button" id="cfr-btn-apply-gamer" value="Activate GAMER" />
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <span style="font-size:12px;color:#ccc;">⚡ UNCAPPED</span>
            <span id="cfr-uncapped-status" style="font-size:11px;color:#555;">inactive</span>
          </div>
          <div class="cfr-btn-row">
            <input type="button" class="menu_button" id="cfr-btn-apply-uncapped" value="Activate UNCAPPED" />
          </div>
        </div>
      </div>

      <!-- CONSTELLATION MANAGER -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">🌌 Constellations</div>
        <div class="cfr-settings-section">
          <div style="font-size:10px;color:#888;margin-bottom:8px;line-height:1.4;">
            Add constellations from any source — anime, manga, web novels, fanfics, original systems.
            Base constellations are read-only. Custom ones can be deleted.
          </div>
          <div class="cfr-form-field">
            <label>Name (e.g. JJK — Cursed Techniques)</label>
            <input type="text" id="cfr-const-name-input" placeholder="Display name..." />
          </div>
          <div class="cfr-form-field">
            <label>Category</label>
            <select id="cfr-const-cat-select" style="font-size:12px;">
              <option value="Anime / Manga">Anime / Manga</option>
              <option value="Web Novel / Light Novel">Web Novel / Light Novel</option>
              <option value="Fanfiction">Fanfiction (SB / QQ / AO3)</option>
              <option value="Manhwa / Manhua">Manhwa / Manhua</option>
              <option value="Game">Game</option>
              <option value="Western Media">Western Media</option>
              <option value="Jumpchain Source">Jumpchain Source</option>
              <option value="Original System">Original System</option>
              <option value="Custom">Custom</option>
            </select>
          </div>
          <div class="cfr-btn-row" style="margin-bottom:8px;">
            <input type="button" class="menu_button" id="cfr-btn-const-add" value="➕ Add Constellation" />
          </div>
          <div id="cfr-const-status" class="cfr-status-msg"></div>
          <div id="cfr-const-list" style="margin-top:8px;"></div>
        </div>
      </div>

      <!-- PROFILES -->
      <div class="cfr-manual-section">
        <div class="cfr-manual-title">📋 Profiles</div>
        <div class="cfr-settings-section">
          <div class="cfr-form-field">
            <label>Active Profile</label>
            <select id="cfr-profile-select" style="width:100%;padding:4px 6px;background:#111;border:1px solid #333;color:#ccc;border-radius:4px;font-size:12px;">
              <option value="default">default</option>
            </select>
          </div>
          <div class="cfr-btn-row" style="margin-top:5px;">
            <input type="button" class="menu_button" id="cfr-btn-profile-load"  value="📂 Load" />
            <input type="button" class="menu_button" id="cfr-btn-profile-save"  value="💾 Save" />
          </div>
          <div class="cfr-form-field" style="margin-top:6px;">
            <label>New / Duplicate name</label>
            <input type="text" id="cfr-profile-name-input" placeholder="e.g. branch-lungfight" style="font-size:12px;" />
          </div>
          <div class="cfr-btn-row" style="margin-top:4px;">
            <input type="button" class="menu_button" id="cfr-btn-profile-new"   value="➕ New Profile" />
            <input type="button" class="menu_button" id="cfr-btn-profile-dupe"  value="📋 Duplicate" />
          </div>
          <div id="cfr-profile-status" class="cfr-status-msg"></div>
        </div>
      </div>

    </div>
  </div>
</div>`;
}


// ============================================================
//  TRACKER DRAWER UI UPDATE
// ============================================================

function updateGlobalModStatus() {
    if (!cfrTracker) return;
    const gamerEl   = document.getElementById('cfr-gamer-status');
    const uncapEl   = document.getElementById('cfr-uncapped-status');
    if (gamerEl) {
        gamerEl.textContent = cfrTracker.state.has_gamer ? 'ACTIVE' : 'inactive';
        gamerEl.style.color = cfrTracker.state.has_gamer ? '#2ecc71' : '#555';
    }
    if (uncapEl) {
        uncapEl.textContent = cfrTracker.state.has_uncapped ? 'ACTIVE' : 'inactive';
        uncapEl.style.color = cfrTracker.state.has_uncapped ? '#e94560' : '#555';
    }
}

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
            const active = p.scaling.scaling_active;
            const unc    = p.scaling.uncapped;
            const maxS   = unc ? '∞' : p.scaling.maxLevel;
            const pct    = p.scaling.xp_percent || 0;
            if (active) {
                const labelCls = unc ? 'unc' : '';
                const fillCls  = unc ? 'unc' : '';
                scaling = `
                <div class="cfr-scaling-bar">
                  <span class="cfr-scaling-label ${labelCls}">Lv.${p.scaling.level}/${maxS}</span>
                  <div class="cfr-scaling-progress">
                    <div class="cfr-scaling-fill ${fillCls}" style="width:${pct}%"></div>
                  </div>
                  <span class="cfr-scaling-xp">${p.scaling.xp}/${p.scaling.xp_needed} XP</span>
                </div>`;
            } else {
                scaling = `<div class="cfr-scaling-bar" style="opacity:0.3;"><span class="cfr-scaling-label" style="color:#444;">Lv.${p.scaling.level} dormant</span><div class="cfr-scaling-progress"><div class="cfr-scaling-fill" style="width:0%"></div></div><span class="cfr-scaling-xp" style="color:#333;">— XP</span></div>`;
            }
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

    $('.cfr-perk-toggle').off('click').on('click', function(e) {
        e.stopPropagation();
        cfrTracker.togglePerk($(this).data('perk'));
    });

    populatePerkDropdowns();
    updateGlobalModStatus();
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
            <div class="cfr-hud-sub" id="cfr-hud-profile" style="color:#f1c40f;font-size:9px;margin-top:1px;">profile: default</div>
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
            const active = p.scaling.scaling_active;
            const pct    = p.scaling.xp_percent || 0;
            const maxL   = p.scaling.uncapped ? '∞' : p.scaling.maxLevel;
            if (active) {
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
            } else {
                scaling = `<div style="margin-top:3px;font-size:9px;color:#333;font-style:italic;">Lv.${p.scaling.level} dormant</div>`;
            }
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

function refreshLastDetail() {
    const msgs = document.querySelectorAll('#chat .mes:not(.is_user)');
    if (!msgs.length) return;
    injectDetailsIntoMessage(msgs[msgs.length - 1]);
}

function refreshAllDetails() {
    if (!cfrTracker?.getSetting('inject_details')) return;
    document.querySelectorAll('#chat .mes:not(.is_user)').forEach(el => {
        if (el.querySelector('.cfr-details-block')) {
            injectDetailsIntoMessage(el);
        }
    });
    refreshLastDetail();
}


// ============================================================
//  FORGE BLOCK HIDING
// ============================================================

function hideForgeBlocks() {
    if (!cfrTracker?.getSetting('hide_forge_blocks')) return;
    document.querySelectorAll('#chat pre').forEach(pre => {
        const code = pre.querySelector('code');
        if (!code) return;
        const isForge = code.classList.contains('language-forge') ||
                        code.textContent.trim().startsWith('```forge') ||
                        pre.previousSibling?.textContent?.includes('```forge');
        if (isForge || pre.textContent.includes('"characterName"') && pre.textContent.includes('"stats"')) {
            pre.classList.add('cfr-forge-hidden');
        }
    });

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
    $(document).on('click', '.cfr-tab', function() {
        const target = $(this).data('tab');
        $('.cfr-tab').removeClass('active');
        $('.cfr-tab-content').removeClass('active');
        $(this).addClass('active');
        $(`#${target}`).addClass('active');
    });

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

    $('#cfr-edit-select').on('change', function() {
        const name = $(this).val();
        if (!name) { $('#cfr-edit-form').hide(); return; }

        const perk = cfrTracker.state.acquired_perks.find(p => p.name === name);
        if (!perk) return;

        $('#cfr-edit-name').val(perk.name);
        $('#cfr-edit-cost').val(perk.cost);
        $('#cfr-edit-desc').val(perk.description);
        $('#cfr-edit-active').prop('checked', perk.active);

        $('#cfr-edit-flags .cfr-edit-flag').each(function() {
            $(this).prop('checked', perk.flags.includes(this.value));
        });

        const isActive = perk.scaling?.scaling_active || perk.flags.includes('SCALING') || perk.flags.includes('UNCAPPED');
        $('#cfr-edit-scaling-fields').addClass('visible');
        $('#cfr-edit-level').val(perk.scaling?.level || 1);
        $('#cfr-edit-xp').val(perk.scaling?.xp || 0);
        $('#cfr-edit-scaling-fields').css('opacity', isActive ? '1' : '0.4');
        const dormantNote = document.getElementById('cfr-scaling-dormant-note');
        if (dormantNote) dormantNote.style.display = isActive ? 'none' : 'block';

        const hasActiveScaling = isActive;
        const sd = perk.scaling_description;
        const hasSd = sd && typeof sd === 'object' && Object.keys(sd).length > 0;
        const descSection = document.getElementById('cfr-edit-scaling-desc-section');
        const descMissing = document.getElementById('cfr-scaling-desc-missing');
        const descTa      = document.getElementById('cfr-edit-scaling-desc');
        if (descSection) descSection.style.display = hasActiveScaling ? 'block' : 'none';
        if (descMissing) descMissing.style.display = (hasActiveScaling && !hasSd) ? 'block' : 'none';
        if (descTa)      descTa.value = hasSd ? scalingDescToText(sd) : '';
        const postPrompt = document.getElementById('cfr-post-save-gen-prompt');
        if (postPrompt) postPrompt.style.display = 'none';

        $('#cfr-edit-form').show();
        refreshPerkOverrideStatus(perk);
    });

    $(document).on('change', '#cfr-edit-flags .cfr-edit-flag', function() {
        const flagActive = $('#cfr-edit-flags input[value="SCALING"]').prop('checked')
            || $('#cfr-edit-flags input[value="UNCAPPED"]').prop('checked');
        $('#cfr-edit-scaling-fields').addClass('visible').css('opacity', flagActive ? '1' : '0.4');
        const dormantNote = document.getElementById('cfr-scaling-dormant-note');
        if (dormantNote) dormantNote.style.display = flagActive ? 'none' : 'block';
        const descSection = document.getElementById('cfr-edit-scaling-desc-section');
        if (descSection) descSection.style.display = flagActive ? 'block' : 'none';
    });

    $('#cfr-btn-save-edit').on('click', () => {
        const original = $('#cfr-edit-select').val();
        if (!original) { showStatus('cfr-edit-status', '⚠️ Select a perk first', 'err'); return; }

        const flags = [];
        $('#cfr-edit-flags .cfr-edit-flag:checked').each((_, el) => flags.push(el.value));

        const rawSdText  = $('#cfr-edit-scaling-desc').val().trim();
        const parsedSd   = rawSdText ? extractScalingDescription(rawSdText) : null;
        const updates = {
            name:               $('#cfr-edit-name').val().trim() || original,
            cost:               parseInt($('#cfr-edit-cost').val()) || 0,
            description:        $('#cfr-edit-desc').val().trim(),
            flags,
            active:             $('#cfr-edit-active').prop('checked'),
            level:              parseInt($('#cfr-edit-level').val()) || 1,
            xp:                 parseInt($('#cfr-edit-xp').val())   || 0,
            scaling_description: parsedSd
        };

        const result = cfrTracker.editPerk(original, updates);
        if (result.success) {
            showStatus('cfr-edit-status', '✅ Saved', 'ok');
            const savedPerk = cfrTracker.state.acquired_perks.find(p => p.name === (updates.name || original));
            const needsDesc = savedPerk?.scaling?.scaling_active
                && (!savedPerk.scaling_description || !Object.keys(savedPerk.scaling_description || {}).length)
                && !rawSdText;
            const postPrompt = document.getElementById('cfr-post-save-gen-prompt');
            if (postPrompt) postPrompt.style.display = needsDesc ? 'block' : 'none';
            if (needsDesc) postPrompt.dataset.perkName = updates.name || original;
            if (!needsDesc) $('#cfr-edit-select').val('').trigger('change');
        } else {
            showStatus('cfr-edit-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    $('#cfr-btn-gen-scaling-desc').on('click', async () => {
        const name = $('#cfr-edit-select').val();
        if (!name) return;
        const perk = cfrTracker.state.acquired_perks.find(p => p.name === name);
        if (!perk) return;
        showStatus('cfr-scaling-desc-status', '⏳ Generating…', 'ok');
        $('#cfr-btn-gen-scaling-desc').prop('disabled', true);
        const text = await generatePerkScalingDesc(perk);
        $('#cfr-btn-gen-scaling-desc').prop('disabled', false);
        if (text) {
            $('#cfr-edit-scaling-desc').val(text);
            showStatus('cfr-scaling-desc-status', '✅ Generated — review then hit Save Changes to commit', 'ok');
            $('#cfr-btn-save-edit').css({'background':'rgba(241,196,15,0.2)','border-color':'#f1c40f','color':'#f1c40f'});
        } else {
            showStatus('cfr-scaling-desc-status', '⚠️ Generation failed — check ST connection', 'err');
        }
    });

    $('#cfr-post-save-yes').on('click', async () => {
        const postPrompt = document.getElementById('cfr-post-save-gen-prompt');
        const perkName   = postPrompt?.dataset?.perkName;
        if (!perkName) return;
        const perk = cfrTracker.state.acquired_perks.find(p => p.name === perkName);
        if (!perk) return;
        postPrompt.innerHTML = '<div style="font-size:10px;color:#888;padding:4px;">⏳ Generating…</div>';
        const text = await generatePerkScalingDesc(perk);
        if (text) {
            $('#cfr-edit-select').val(perkName).trigger('change');
            $('#cfr-edit-scaling-desc').val(text);
            showStatus('cfr-scaling-desc-status', '✅ Generated — review then hit Save Changes', 'ok');
            $('#cfr-btn-save-edit').css({'background':'rgba(241,196,15,0.2)','border-color':'#f1c40f','color':'#f1c40f'});
            if (postPrompt) postPrompt.style.display = 'none';
        } else {
            if (postPrompt) postPrompt.innerHTML = '<div style="font-size:10px;color:#e74c3c;padding:4px;">⚠️ Generation failed. You can try again with ✨ Generate Level Descriptors above.</div>';
        }
    });

    $(document).on('click', '#cfr-post-save-no', () => {
        const postPrompt = document.getElementById('cfr-post-save-gen-prompt');
        if (postPrompt) postPrompt.style.display = 'none';
        $('#cfr-edit-select').val('').trigger('change');
    });

    $(document).on('input', '#cfr-edit-scaling-desc', () => {
        $('#cfr-btn-save-edit').css({'background':'','border-color':'','color':''});
    });

    $('#cfr-btn-perk-scale').on('click', () => {
        const name = $('#cfr-edit-select').val();
        if (!name) { showStatus('cfr-edit-status', '⚠️ Select a perk first', 'err'); return; }
        const result = cfrTracker.enablePerkScaling(name);
        if (result.success) {
            const perk = cfrTracker.state.acquired_perks.find(p => p.name === name);
            refreshPerkOverrideStatus(perk);
            $('#cfr-edit-flags input[value="SCALING"]').prop('checked', true);
            $('#cfr-edit-scaling-fields').addClass('visible');
            if (perk?.scaling) {
                $('#cfr-edit-level').val(perk.scaling.level);
                $('#cfr-edit-xp').val(perk.scaling.xp);
            }
            updateTrackerUI();
            updateHUD();
            updatePromptInjection();
            showStatus('cfr-edit-status', `✅ Scaling enabled for "${name}"`, 'ok');
        } else if (result.reason === 'already_scaling') {
            showStatus('cfr-edit-status', `"${name}" already has scaling`, 'ok');
        } else {
            showStatus('cfr-edit-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    $('#cfr-btn-perk-uncap').on('click', () => {
        const name = $('#cfr-edit-select').val();
        if (!name) { showStatus('cfr-edit-status', '⚠️ Select a perk first', 'err'); return; }
        const result = cfrTracker.enablePerkUncapped(name);
        if (result.success) {
            const perk = cfrTracker.state.acquired_perks.find(p => p.name === name);
            refreshPerkOverrideStatus(perk);
            $('#cfr-edit-flags input[value="SCALING"]').prop('checked', true);
            $('#cfr-edit-flags input[value="UNCAPPED"]').prop('checked', true);
            $('#cfr-edit-scaling-fields').addClass('visible');
            if (perk?.scaling) {
                $('#cfr-edit-level').val(perk.scaling.level);
                $('#cfr-edit-xp').val(perk.scaling.xp);
            }
            updateTrackerUI();
            updateHUD();
            updatePromptInjection();
            showStatus('cfr-edit-status', `✅ Level cap removed for "${name}"`, 'ok');
        } else if (result.reason === 'already_uncapped') {
            showStatus('cfr-edit-status', `"${name}" is already uncapped`, 'ok');
        } else {
            showStatus('cfr-edit-status', `⚠️ ${result.reason}`, 'err');
        }
    });

    $('#cfr-btn-remove-perk').on('click', () => {
        const name = $('#cfr-remove-select').val();
        if (!name) { showStatus('cfr-remove-status', '⚠️ Select a perk first', 'err'); return; }
        if (!confirm(`Remove "${name}"? This cannot be undone.`)) return;

        const result = cfrTracker.removePerk(name);
        showStatus('cfr-remove-status', result.success ? `✅ ${name} removed` : `⚠️ ${result.reason}`,
            result.success ? 'ok' : 'err');
    });

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

function refreshPerkOverrideStatus(perk) {
    const scaleEl = document.getElementById('cfr-perk-scale-status');
    const uncapEl = document.getElementById('cfr-perk-uncap-status');
    if (!perk) {
        if (scaleEl) { scaleEl.textContent = ''; }
        if (uncapEl) { uncapEl.textContent = ''; }
        return;
    }

    if (scaleEl) {
        const hasScale = !!perk.scaling || perk.flags.includes('SCALING');
        scaleEl.textContent  = hasScale ? '✓ active' : '';
        scaleEl.style.color  = hasScale ? '#2ecc71'  : '#555';
    }
    if (uncapEl) {
        const isUncap = perk.scaling?.uncapped || perk.flags.includes('UNCAPPED');
        uncapEl.textContent  = isUncap ? '✓ active' : '';
        uncapEl.style.color  = isUncap ? '#e94560'  : '#555';
    }
}

window.cfrDeleteConstellation = async function(key) {
    if (!confirm(`Remove constellation "${key}" from the list?
Perk data is preserved — you can re-add later.`)) return;
    const result = await dbRemoveConstellation(key);
    if (result.success) {
        showStatus('cfr-const-status', `✅ Removed "${key}" (${result.perks_preserved} perks preserved in DB)`, 'ok');
    } else {
        showStatus('cfr-const-status', `⚠️ ${result.reason}`, 'err');
    }
};

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

    $('#cfr-btn-gist-save').on('click', () => {
        const id  = $('#cfr-gist-id').val().trim();
        const pat = $('#cfr-gist-pat').val().trim();
        if (!id || !pat) {
            showStatus('cfr-gist-status', '⚠️ Both Gist ID and PAT required', 'err');
            return;
        }
        cfrSettings.gist_id  = id;
        cfrSettings.gist_pat = pat;
        cfrSaveDebounced();
        showStatus('cfr-gist-status', '✅ Credentials saved — use Push or Pull to sync data', 'ok');
    });

    $('#cfr-btn-gist-push').on('click', async () => {
        if (!cfrSettings?.gist_id || !cfrSettings?.gist_pat) {
            showStatus('cfr-gist-status', '⚠️ Save credentials first', 'err');
            return;
        }
        showStatus('cfr-gist-status', '⬆ Pushing to Gist…', 'ok');
        await gistSaveState();
        await gistSaveDB();
        showStatus('cfr-gist-status', '✅ Local state pushed to Gist', 'ok');
    });

    $('#cfr-btn-gist-pull').on('click', async () => {
        if (!cfrSettings?.gist_id || !cfrSettings?.gist_pat) {
            showStatus('cfr-gist-status', '⚠️ Save credentials first', 'err');
            return;
        }
        if (!confirm('Pull from Gist? This will overwrite your current local state with whatever is saved in the Gist.')) return;
        showStatus('cfr-gist-status', '⬇ Pulling from Gist…', 'ok');
        await gistLoad();
        updateTrackerUI();
        updateHUD();
        updatePromptInjection();
        showStatus('cfr-gist-status', '✅ State pulled from Gist', 'ok');
    });
}

function loadExtensionSettingsUI() {
    $('#cfr-enabled').prop('checked',        cfrSettings.enabled);
    $('#cfr-auto-parse').prop('checked',     cfrSettings.auto_parse_forge);
    $('#cfr-inject-details').prop('checked', cfrSettings.inject_details);
    $('#cfr-hide-forge').prop('checked',     cfrSettings.hide_forge_blocks);
    $('#cfr-debug').prop('checked',          cfrSettings.debug_mode);
    $('#cfr-cp-per-resp').val(               cfrSettings.cp_per_response);

    if (cfrSettings.gist_id)  $('#cfr-gist-id').val(cfrSettings.gist_id);
    if (cfrSettings.gist_pat) $('#cfr-gist-pat').val(cfrSettings.gist_pat);
    updateProfileUI();
}


// ============================================================
//  MESSAGE HANDLING
// ============================================================

function stampForgeBlock() {
    if (!cfrTracker) {
        showRollToast('Tracker not initialised', true);
        return;
    }

    const block = cfrTracker.toForgeInjection();
    if (!block) {
        showRollToast('Nothing to stamp — no state loaded', true);
        return;
    }

    const ta = document.getElementById('send_textarea');
    if (!ta) {
        navigator.clipboard?.writeText(block).then(() => {
            showRollToast('📋 Forge block copied to clipboard — paste into chat');
        }).catch(() => {
            showRollToast('⚠️ Could not find send box — open console for block', true);
            console.log('[CFR] Forge block: ' + block);
        });
        return;
    }

    const existing = ta.value.trim();
    ta.value = existing ? `${block}\n\n${existing}` : block;

    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();

    showRollToast('📋 Forge block ready in send box — review and send');
}

function forceSyncPrompt() {
    if (!cfrTracker) return;
    updatePromptInjection();
    showRollToast('⚡ Prompt synced — AI context updated');
}

window.stampForgeBlock  = stampForgeBlock;
window.forceSyncPrompt  = forceSyncPrompt;

async function onMessageReceived(data) {
    if (!cfrTracker || !cfrSettings?.enabled) return;

    const ctx = SillyTavern.getContext();

    const idx = (ctx?.chat?.length ?? 0) - 1;
    if (idx <= cfrLastMsgIdx) return;
    cfrLastMsgIdx = idx;

    let text = ctx?.chat?.[idx]?.mes || '';

    if (!text) {
        text = typeof data === 'string' ? data
             : (data?.message || data?.mes || data?.content || '');
    }

    if (ctx?.chat?.[idx]?.is_user) return;

    if (!text) {
        if (cfrSettings.debug_mode) console.warn('[CFR] ⚠️ Empty text at idx', idx);
        return;
    }

    if (cfrSettings.debug_mode) console.log('[CFR] 📨 Processing message idx', idx, '— text length:', text.length);

    const isAwaitingRoll = cfrAwaitingCreation || cfrGetAwaiting();
    if (isAwaitingRoll) {
        await finalizeCreationRoll(text);
    } else {
        passivePerkScan(text);
    }

    cfrTracker.processResponse(text);

    setTimeout(() => gistSaveState(), 2000);

    setTimeout(() => {
        refreshLastDetail();
        hideForgeBlocks();
    }, 300);
}

// FIX: Debounce guard prevents onChatChanged from firing multiple times simultaneously.
// ST can fire CHAT_CHANGED + CHAT_LOADED + CHARACTER_LOADED in rapid succession on
// a single chat switch, which was causing duplicate Gist pulls and state stomping.
let cfrChatChangePending = false;

async function onChatChanged() {
    if (cfrChatChangePending) return;
    cfrChatChangePending = true;
    setTimeout(() => { cfrChatChangePending = false; }, 500);

    if (!cfrTracker) return;
    cfrLastMsgIdx = -1;

    if (cfrActiveRoll) {
        cfrActiveRoll = null;
        hideRollCard?.();
    }
    if (cfrAwaitingCreation || cfrGetAwaiting()) {
        cfrAwaitingCreation = false;
        cfrSetAwaiting(false);
        try {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.setExtensionPrompt === 'function') {
                ctx.setExtensionPrompt('cfr-creation-roll', '', 0, 0);
            }
        } catch(e) {}
    }

    const ctx      = SillyTavern.getContext();
    const localKey = ctx?.chatId ? `cfr_${ctx.chatId}` : null;
    const hasLocal = localKey && !!localStorage.getItem(localKey);

    cfrTracker.load();

    if (!hasLocal && cfrSettings?.gist_id && cfrSettings?.gist_pat) {
        if (cfrSettings.debug_mode) console.log('[CFR] New chat — pulling profile from Gist:', getActiveProfile());
        showStatus('cfr-gist-status', '⬇ Loading profile for new chat…', 'ok');
        try {
            await gistLoad(getActiveProfile());
            cfrTracker.save();
            showStatus('cfr-gist-status', `✅ Profile "${getActiveProfile()}" loaded`, 'ok');
        } catch(e) {
            console.warn('[CFR] Gist pull on chat change failed:', e);
        }
    }

    updateTrackerUI();
    updateHUD();
    updatePromptInjection();
    updateProfileUI();

    setTimeout(() => {
        refreshAllDetails();
        hideForgeBlocks();
    }, 500);

    if (cfrSettings?.debug_mode) console.log('[CFR] 💬 Chat changed — state:', cfrTracker.state.acquired_perks.length, 'perks,', cfrTracker.state.available_cp, 'CP');
}


// ============================================================
//  MUTATION OBSERVER
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

                if (node.classList?.contains('mes') && !node.classList.contains('is_user')) {
                    setTimeout(() => {
                        const mesId = parseInt(node.getAttribute('mesid') ?? '-1');
                        const ctx   = SillyTavern.getContext();
                        const raw   = (mesId >= 0 && ctx?.chat?.[mesId]?.mes) ? ctx.chat[mesId].mes : null;
                        if (raw) onMessageReceived(raw);
                        injectDetailsIntoMessage(node);
                        hideForgeBlocks();
                    }, 500);
                }

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

    for (const evName of ['CHAT_CREATED', 'CHAT_LOADED', 'CHARACTER_LOADED']) {
        if (cfrEventTypes[evName]) {
            cfrEventSource.on(cfrEventTypes[evName], onChatChanged);
            bound++;
            console.log(`[CFR] ✅ Bound: ${evName}`);
        }
    }

    console.log(`[CFR] 🎯 ${bound} events bound`);
}

jQuery(async () => {
    console.log('[CFR] 🚀 Celestial Forge Reformed v1.0.1 initializing…');

    loadSettings();

    $('#extensions_settings').append(getCFRSettingsHtml());

    cfrTracker = new CelestialForgeTracker();
    cfrTracker.load();

    injectHUD();

    bindManualControls();
    bindExtensionSettings();
    bindRollButtons();
    loadExtensionSettingsUI();

    updateTrackerUI();
    updateHUD();
    updateBankedList();
    updatePromptInjection();

    window.cfrTracker                 = cfrTracker;
    window.CelestialForgeTracker      = CelestialForgeTracker;
    window.getCelestialForgeInjection = () => cfrTracker?.toContextBlock()   || '';
    window.getCelestialForgeJSON      = () => cfrTracker?.toForgeInjection() || '';
    window.getCelestialForgePrompt    = () => buildPromptBlock()             || '';
    window.cfrPerkDB                  = () => cfrPerkDB;
    window.cfrGistSaveDB              = gistSaveDB;
    window.cfrGistSaveState           = gistSaveState;

    setupEventListeners();

    if (cfrSettings?.gist_id && cfrSettings?.gist_pat) {
        gistLoad().then(() => {
            updateTrackerUI();
            updateHUD();
            updateBankedList();
            updatePromptInjection();
            updateProfileUI();
            refreshConstellationDropdowns();
            console.log('[CFR] ☁️ Gist sync complete on init');
        }).catch(e => console.warn('[CFR] Gist init load failed:', e));
    } else {
        cfrPerkDB = buildEmptyDB();
        refreshConstellationDropdowns();
        console.log('[CFR] ℹ️ No Gist configured — using local DB only. Add Gist ID + PAT in Settings.');
    }

    setTimeout(() => {
        setupObserver();
        refreshAllDetails();
        hideForgeBlocks();
    }, 1000);

    console.log('[CFR] ✨ Ready!', cfrTracker.status());
});

// NOTE: No `export` statement — ST loads this as a plain script, not an ES module.
