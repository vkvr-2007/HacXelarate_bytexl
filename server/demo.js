// The fictional demo brand. Its scans read only the hand-labelled demo dataset (ml/data/seed_corpus.json).
export const DEMO_BRAND = {
  name: 'Northstar',
  domain: 'northstar.com',
  domains: [],
  description: 'A modern financial platform helping people move money with confidence. Send money, pay bills and track spending.',
  logoUrl: '/seed-icons/northstar-official.png',
  aliases: [],
  keywords: ['money', 'transfer'],
  officialSocials: [
    { platform: 'Instagram', handle: '@northstar' },
    { platform: 'X', handle: '@northstarhq' },
    { platform: 'LinkedIn', handle: 'northstar-inc' },
  ],
  officialApps: [
    { store: 'App Store', name: 'Northstar: Money, made clear', appId: 'id6478214501', publisher: 'Northstar Financial, Inc.' },
    { store: 'Google Play', name: 'Northstar', appId: 'com.northstar.mobile', publisher: 'Northstar Financial, Inc.' },
  ],
  sources: null,
  scanIntervalMinutes: null,
};
