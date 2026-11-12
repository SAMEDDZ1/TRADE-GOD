"""Regenerate the TRADE GOD crew: shared/specialties.js BUILTINS + frontend/app/classicons.js seals/codes.
Usage: python3 -I gen_roster.py <repo-root>   (run from anywhere; reads roster.py / seals.py next to this file)"""
import sys, os, re, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import roster, seals

ROOT = sys.argv[1]
J = lambda s: json.dumps(s, ensure_ascii=False)

def js_spec(r):
    tags = ', '.join('%s: %s' % (k, v) for k, v in r['tags'].items())
    return ('    {\n'
            '      id: %s, name: %s, emoji: %s, tagline: %s,\n' % (J(r['id']), J(r['name']), J(r['emoji']), J(r['tagline'])) +
            '      dept: %s, aiHint: %s,\n' % (J(r['dept']), J(r['ai'])) +
            '      blurb: %s,\n' % J(r['blurb']) +
            '      persona: %s, model: %s, accent: %s,\n' % (J(r['persona']), J(r['model']), J(r['accent'])) +
            '      tags: { %s },\n' % tags +
            '      kit: %s, skills: %s, reasoningEffort: %s,\n' % (J(r['kit']), J(r['skills']), J(r['effort'])) +
            '      purpose: %s,\n' % J(r['purpose']) +
            '      manual: %s,\n' % J(r['manual']) +
            '      starters: %s\n' % J(r['starters']) +
            '    }')

# ---------- shared/specialties.js ----------
p = os.path.join(ROOT, 'shared/specialties.js')
s = open(p, encoding='utf-8').read()
a = s.index('  const BUILTINS = [')
b = s.index('\n  ];', a) + len('\n  ];')
depts = []
for r in roster.R:
    if r['dept'] not in depts: depts.append(r['dept'])
block = '  const BUILTINS = [\n'
parts = []
for d in depts:
    parts.append('    // ================= ' + d.upper() + ' =================\n' +
                 ',\n'.join(js_spec(r) for r in roster.R if r['dept'] == d))
block += ',\n'.join(parts) + '\n  ];'
s = s[:a] + block + s[b:]
s = re.sub(r"const DEFAULT_ID = '[a-z]+';", "const DEFAULT_ID = 'headcoach';", s)
# the department order is part of the catalog (the bay groups the roster by it)
if 'const DEPARTMENTS' not in s:
    s = s.replace("  const TAGS = ['code', 'research', 'general'];",
                  "  const TAGS = ['code', 'research', 'general'];\n\n"
                  "  // TRADE GOD: the company's departments, in floor order (the Recruitment Bay groups the roster by these).\n"
                  "  const DEPARTMENTS = " + J(depts) + ";")
    s = s.replace('return { BUILTINS, ARCHETYPES, TIERS, TAGS, DEFAULT_ID };',
                  'return { BUILTINS, ARCHETYPES, TIERS, TAGS, DEFAULT_ID, DEPARTMENTS };')
else:
    s = re.sub(r'const DEPARTMENTS = \[.*?\];', 'const DEPARTMENTS = ' + J(depts) + ';', s)
open(p, 'w', encoding='utf-8').write(s)

# ---------- frontend/app/classicons.js ----------
p = os.path.join(ROOT, 'frontend/app/classicons.js')
s = open(p, encoding='utf-8').read()
arch_ids = re.findall(r"id: '([a-z0-9]+)'", open(os.path.join(ROOT, 'shared/specialties.js'), encoding='utf-8').read().split('const ARCHETYPES = [')[1])
new_ids = [r['id'] for r in roster.R]
a = s.index('  const ICONS = {')
b = s.index('\n};', a)   # the ICONS literal closes at column 0
lines = s[a:b].split('\n')[1:]
kept = []
for ln in lines:
    m = re.match(r'\s*"([a-z0-9]+)": ', ln)
    if m and m.group(1) in arch_ids and m.group(1) not in new_ids:
        kept.append(ln.rstrip().rstrip(','))
new_lines = ['  ' + J(i) + ': ' + J(seals.svg(i)) for i in new_ids]
s = s[:a] + '  const ICONS = {\n' + ',\n'.join(new_lines + kept) + s[b:]
# CODE map
a = s.index('  const CODE = {')
b = s.index('\n  };', a)
old = dict(re.findall(r"([a-z0-9]+): '([A-Z0-9]{3})'", s[a:b]))
code = dict(seals.CODES)
for i in arch_ids:
    if i not in code:
        assert i in old, i
        assert old[i] not in code.values(), (i, old[i])
        code[i] = old[i]
body = '  const CODE = {\n    // the TRADE GOD crew\n'
items = ["%s: '%s'" % (i, code[i]) for i in new_ids]
for k in range(0, len(items), 6): body += '    ' + ', '.join(items[k:k + 6]) + ',\n'
body += '    // the specialist archive (deep cuts)\n'
items = ["%s: '%s'" % (i, code[i]) for i in arch_ids if i not in new_ids]
for k in range(0, len(items), 6): body += '    ' + ', '.join(items[k:k + 6]) + (',\n' if k + 6 < len(items) else '\n')
s = s[:a] + body.rstrip('\n') + s[b:]
# mission / category seals that pointed at retired classes
for old_ref, new_ref in [('ICONS.deployer', 'ICONS.executor'), ('ICONS.envoy', 'ICONS.brokerlink'), ('ICONS.copywriter', 'ICONS.journal'),
                         ('ICONS.taskmaster', 'ICONS.headcoach'), ('ICONS.engineer', 'ICONS.dataeng'), ('ICONS.writer', 'ICONS.journal'),
                         ('ICONS.producer', 'ICONS.breeder')]:
    s = s.replace(old_ref, new_ref)
open(p, 'w', encoding='utf-8').write(s)

# ---------- frontend/app/specialties.js: carry dept + aiHint through freezeSpec ----------
p = os.path.join(ROOT, 'frontend/app/specialties.js')
s = open(p, encoding='utf-8').read()
if 'dept:' not in s:
    s = s.replace("      tagline: s.tagline || '',\n      blurb: s.blurb || '',\n      purpose: s.purpose || '',                       // -> purpose.md",
                  "      tagline: s.tagline || '',\n      blurb: s.blurb || '',\n"
                  "      dept: s.dept || '',                             // TRADE GOD: the company department this role sits in\n"
                  "      aiHint: s.aiHint || '',                         // TRADE GOD: the AI platform this role suits best (advisory only)\n"
                  "      purpose: s.purpose || '',                       // -> purpose.md")
    assert 'dept:' in s
    open(p, 'w', encoding='utf-8').write(s)
print('crew:', len(new_ids), 'archive:', len([i for i in arch_ids if i not in new_ids]))
