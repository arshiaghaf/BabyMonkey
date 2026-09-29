import { headers } from 'next/headers';
import { IdentityGateway } from '@/components/IdentityGateway';
import { AuthorizedIdentityPresentation } from '@/components/AuthorizedIdentityPresentation';
import { resolveRequestAuthority } from '@/server/identity/authority';
import { resolveRequestSignalSnapshot } from '@/server/signal/authority';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export default async function Home() {
  if (process.env.NODE_ENV === 'development' && process.env.BABYMONKEY_LOCAL_DEMO !== '1') {
    const { LocalStatePreview } = await import('@/components/LocalStatePreview');
    return <LocalStatePreview />;
  }

  const requestHeaders = await headers();
  const request = new Request(
    'https://authority.invalid/',
    { headers: { cookie: requestHeaders.get('cookie') ?? '' } },
  );
  const authority = await resolveRequestAuthority(request);
  if (!authority.authorized) return <IdentityGateway />;

  const { protectedPresentation } = await import('@/server/protected/presentation');
  const initialInteraction = await resolveRequestSignalSnapshot(request);
  return (
    <AuthorizedIdentityPresentation
      {...protectedPresentation}
      initialInteraction={initialInteraction}
    />
  );
}
