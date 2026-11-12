# The TRADE GOD crew — source

`roster.py` is the source of the 36 trading roles (job, rules, starter tasks, kit, skills, suggested AI);
`seals.py` holds each role's 12x12 pixel badge and 3-letter code. Regenerate the app's catalog with:

```bash
python3 dev/crew/gen_roster.py .
node test/class-loadouts.test.js && node test/specialties.test.js
```

This rewrites the `BUILTINS` block of `shared/specialties.js` and the crew seals in `frontend/app/classicons.js`.
