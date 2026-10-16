# Library publisher

Publishes text and Markdown files to the shared Starpi library in Supabase, with a 384-dimensional
multilingual-e5-small vector per section. Set-up, commands, configuration and tests are documented
in [backend/README.md](../../backend/README.md#library-publisher).

```bash
python -m publisher fetch-model
python -m publisher publish handbook.md --public
```
