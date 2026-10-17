"""Library publisher: turns text and Markdown files into shared-library rows in Supabase.

Each file is split into heading-based sections, every section gets a 384-dimensional
multilingual-e5-small vector (the model the browser uses for its query vectors), and the rows are
written with the service role key. See backend/README.md for the commands.
"""
