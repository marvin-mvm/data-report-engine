-- Articles table for the engine. The site reads PUBLISHED rows at build time with the public key
-- and prerenders each as /blog/<slug>; writes go through the service role only.
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text,                              -- becomes the meta description: <= 160 chars, keyword first
  content_html text,                         -- no <h1> (the template renders the title), no <script>
  content_markdown text,                     -- plain-text twin for readers and AI crawlers
  meta_description text,                     -- fallback only; keep it equal to excerpt
  hero_image_url text,                       -- on OUR storage bucket, never a vendor's
  language_code text,
  json_ld jsonb,                             -- {"@graph": [Article, Dataset]} for data reports
  faq_json_ld jsonb,                         -- FAQPage
  status text not null default 'draft' check (status in ('publish', 'draft', 'pending')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.articles enable row level security;

-- Anyone may read PUBLISHED articles; drafts stay private. There is no write policy: inserts and
-- updates use the service role, which bypasses RLS.
create policy "public can read published articles"
  on public.articles for select
  to anon, authenticated
  using (status = 'publish');

-- New Supabase projects no longer expose new public tables to the Data API automatically.
grant select on public.articles to anon, authenticated;

create or replace function public.articles_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger articles_set_updated_at
  before update on public.articles
  for each row execute function public.articles_touch_updated_at();

create index articles_status_published_at_idx on public.articles (status, published_at desc);

-- Cover images: a PUBLIC bucket named to match IMAGES_BUCKET.
insert into storage.buckets (id, name, public) values ('blog-images', 'blog-images', true)
  on conflict (id) do nothing;
