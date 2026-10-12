-- ===========================================================================
-- 0048 — B07.1 follow-up: case-insensitive HTML entities in classifier text
-- ===========================================================================
-- Does not edit 0045. private.gmail_commercial_classifier_clean_text decoded
-- &nbsp; &amp; &lt; &gt; with case-sensitive replace(). The outreach transform
-- in src/lib/gmail/outreach/text-transform.ts uses case-insensitive replaces.
-- This replacement keeps the rest of the 0045 function and only changes those
-- four substitutions. 0046 is D01. 0047 is B08. This is the next free number.

create or replace function private.gmail_commercial_classifier_clean_text(
  p_text text,
  p_is_html boolean
)
returns text
language plpgsql
immutable
set search_path = public, private, pg_temp
as $clean$
declare
  v_source text;
  v_lines text[];
  v_cut integer;
  i integer;
  n integer;
  v_kept text;
  v_after text;
  v_line text;
begin
  if p_text is null then
    return null;
  end if;

  v_source := p_text;
  if p_is_html then
    v_source := regexp_replace(v_source, '<blockquote\M.*', '', 'i');
    v_source := regexp_replace(v_source, '<style.*?</style>', ' ', 'gi');
    v_source := regexp_replace(v_source, '<script.*?</script>', ' ', 'gi');
    v_source := regexp_replace(v_source, '<br\s*/?>', E'\n', 'gi');
    v_source := regexp_replace(v_source, '</(p|div|tr|li|table|h[1-6])\s*>', E'\n', 'gi');
    v_source := regexp_replace(v_source, '<[^>]+>', ' ', 'g');
    -- Same four entities as stripHtmlHeuristically, case-insensitive.
    -- replace() is case-sensitive; regexp_replace with 'i' matches &NBSP; and mixed case.
    v_source := regexp_replace(v_source, '&nbsp;', ' ', 'gi');
    v_source := regexp_replace(v_source, '&amp;', '&', 'gi');
    v_source := regexp_replace(v_source, '&lt;', '<', 'gi');
    v_source := regexp_replace(v_source, '&gt;', '>', 'gi');
    v_source := regexp_replace(v_source, '[ \t]+', ' ', 'g');
    v_lines := regexp_split_to_array(v_source, E'\n');
    for i in 1..coalesce(array_length(v_lines, 1), 0) loop
      v_lines[i] := btrim(v_lines[i]);
    end loop;
    v_source := btrim(regexp_replace(array_to_string(v_lines, E'\n'), E'\n{3,}', E'\n\n', 'g'));
  end if;

  v_lines := regexp_split_to_array(v_source, E'\r?\n');
  n := coalesce(array_length(v_lines, 1), 0);
  v_cut := null;
  for i in 1..n loop
    v_line := v_lines[i];
    if v_line ~ '^-- ?$'
       or v_line ~* '^\s*On\s.+\swrote:\s*$'
       or v_line ~* '^\s*-{2,}\s*Original Message\s*-{2,}\s*$'
       or v_line ~* '^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$'
       or v_line ~* '^\s*From:\s.+$'
       or v_line ~ '^\s*>'
    then
      v_cut := i;
      exit;
    end if;
  end loop;

  if v_cut is null then
    v_kept := btrim(v_source);
  elsif v_cut = 1 then
    v_kept := '';
  else
    v_kept := btrim(array_to_string(v_lines[1:v_cut - 1], E'\n'));
  end if;

  v_lines := regexp_split_to_array(v_kept, E'\r?\n');
  n := coalesce(array_length(v_lines, 1), 0);
  v_cut := null;
  for i in 1..n loop
    if v_lines[i] ~* '^\s*(thanks( so much| a lot| in advance)?|thank you|best( regards| wishes)?|kind regards|warm(ly)?( regards)?|regards|sincerely|cheers|talk soon|looking forward( to hearing from you)?)[,!.]?\s*$' then
      if i = n then
        v_after := '';
      else
        v_after := btrim(array_to_string(v_lines[i + 1:n], E'\n'));
      end if;
      if v_after <> '' then
        v_cut := i;
        exit;
      end if;
    end if;
  end loop;

  if v_cut is null then
    return nullif(v_kept, '');
  elsif v_cut = 1 then
    return null;
  end if;
  return nullif(btrim(array_to_string(v_lines[1:v_cut - 1], E'\n')), '');
end;
$clean$;

revoke all on function private.gmail_commercial_classifier_clean_text(text, boolean)
  from public, anon, authenticated;

