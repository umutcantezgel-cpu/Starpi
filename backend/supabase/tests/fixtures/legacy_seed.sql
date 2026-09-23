-- TEST FIXTURE: rows that exist before the hardening migration runs.
-- Only uses columns present in every legacy shape. rls_test.sql (with
-- -v legacy=true) checks how the migration treated them.

\set ON_ERROR_STOP 1

insert into public.knowledge_documents (id, title, summary, raw_content, tags)
values ('11111111-1111-4111-8111-111111111111', 'Legacy Handbuch',
        'Alte Wissensbasis', 'Inhalt aus der Zeit vor der Umstellung', '{legacy}');

insert into public.knowledge_sections (document_id, section_index, heading, markdown_content, embedding)
select '11111111-1111-4111-8111-111111111111', 0, 'Altbestand',
       'Dieser Abschnitt stammt aus dem Altbestand.',
       ('[' || string_agg(case when i = 2 then '1' else '0' end, ',' order by i) || ']')::vector
from generate_series(1, 1536) as i;

-- Chat rows without an owner: the migration deletes them.
insert into public.chat_history (session_id, role, content)
values ('legacy-session', 'user', 'legacy chat row');

do $$
begin
    if to_regclass('public.knowledge_entities') is not null then
        insert into public.knowledge_entities (id, name, entity_type, description)
        values ('22222222-2222-4222-8222-222222222222', 'Legacy Projekt', 'project', 'Altbestand');
        insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type)
        values ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'self');
    end if;
end
$$;
