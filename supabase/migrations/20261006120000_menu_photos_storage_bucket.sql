-- Menu photos move out of app_data (base64 inside ht_plan_config) into a public Storage bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-photos', 'menu-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Public bucket: anyone can view a photo via its public URL.
-- Only the signed-in owner/staff (non-anonymous auth user) can upload or delete.
create policy "menu_photos_staff_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-photos' and (select public.is_staff()));
create policy "menu_photos_staff_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'menu-photos' and (select public.is_staff()));
