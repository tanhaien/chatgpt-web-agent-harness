# Skills

Reusable **playbooks** the agent loads on demand (inspired by Claude skills).
The agent calls `list_skills` to see what's available, then `read_skill(name)`
to load one before doing the work — so instructions stay out of context until
they're actually needed.

## Where skills are discovered

The server scans these locations (first match of a name wins):

1. `AGENT_SKILLS_DIR` — an env var pointing to a skills folder.
2. `skills/` — this folder, shipped with the repo (examples below).
3. `<workspace>/.claude/skills/` and `<workspace>/.agent/skills/` — per-project
   skills (this also reuses any existing **Claude** skills in your repo).

## Skill format

Each skill is a **folder** containing a `SKILL.md` with YAML front matter:

```markdown
---
name: my-skill
description: One line describing when to use this skill.
---

# My skill

Step-by-step instructions for the agent. You can reference other files in this
folder (scripts, templates); their names are returned by `read_skill`.
```

- `name` — short, unique, used by `read_skill`.
- `description` — shown by `list_skills` so the agent can decide relevance.
- The body is free-form Markdown instructions.

Add a new skill by creating `skills/<your-skill>/SKILL.md` (or putting it under
your workspace's `.claude/skills/`).
