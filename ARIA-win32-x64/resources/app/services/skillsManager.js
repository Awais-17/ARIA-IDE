/**
 * skillsManager.js
 * ----------------------------------------------------------------------------
 * Loadable "skills" for ARIA's agentic tool-use loop — small markdown files
 * with YAML-ish frontmatter, conceptually identical to Claude Code's own
 * skill format.
 *
 * Convention: <projectRoot>/.helios/skills/<skill-dir>/SKILL.md
 *   ---
 *   name: my-skill
 *   description: One line the model uses to decide when to invoke this.
 *   ---
 *   Full instructions for the model to follow, in markdown.
 * ----------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const SKILLS_RELATIVE_DIR = path.join('.helios', 'skills');

function parseFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) return { meta: {}, body: raw.trim() };
    const [, frontmatterBlock, body] = match;
    const meta = {};
    for (const line of frontmatterBlock.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        meta[key] = value;
    }
    return { meta, body: body.trim() };
}

/** Lists all skills found under <projectRoot>/.helios/skills/. Returns []  if the folder doesn't exist or on any read error. */
function listSkills(projectRoot) {
    const dir = path.join(projectRoot || '.', SKILLS_RELATIVE_DIR);
    if (!fs.existsSync(dir)) return [];

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

    const skills = [];
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(dir, ent.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        try {
            const { meta } = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'));
            skills.push({ name: meta.name || ent.name, description: meta.description || '', dir: ent.name });
        } catch { /* skip unreadable/malformed skill */ }
    }
    return skills;
}

/** Loads a skill's full body by name (or its folder name as a fallback match). Returns null if not found. */
function loadSkill(projectRoot, name) {
    const found = listSkills(projectRoot).find(s => s.name === name || s.dir === name);
    if (!found) return null;
    try {
        const raw = fs.readFileSync(path.join(projectRoot || '.', SKILLS_RELATIVE_DIR, found.dir, 'SKILL.md'), 'utf-8');
        const { body } = parseFrontmatter(raw);
        return { name: found.name, description: found.description, body };
    } catch {
        return null;
    }
}

module.exports = { listSkills, loadSkill, SKILLS_RELATIVE_DIR };
