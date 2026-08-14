/* Supabase connection for the Energy Matrix Tool.
 *
 * The publishable key is meant to be public — it identifies the project and
 * nothing more. Every table is protected by row level security, so this key
 * grants no read or write access on its own; all access is decided by the
 * signed-in user's JWT against the policies in the database.
 *
 * Never put the service_role key here. That one bypasses RLS entirely and
 * belongs only on a server.
 */
window.KROVA_CONFIG = {
  supabaseUrl: 'https://hcwfccpahhczihovphna.supabase.co',
  supabaseKey: 'sb_publishable_znYmG3h7zqZFCOGUq0COBw_XAGyaDM7',
  trialDays: 14
};
