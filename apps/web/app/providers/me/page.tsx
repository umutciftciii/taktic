import { redirect } from 'next/navigation';
import { apiFetch, getCurrentUser, ProviderProfile } from '../../../lib/api';

export default async function MyProviderPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'PROVIDER') {
    redirect('/login?redirectTo=/providers/me');
  }

  const provider = await apiFetch<ProviderProfile>('/providers/me');
  redirect(`/providers/${provider.id}`);
}
