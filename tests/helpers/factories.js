import { createApplication } from '../../src/data/schema.js';

let counter = 0;
export function assetRef(fileName, extra = {}) {
  counter += 1;
  return {
    assetId: `asset-${counter}`,
    fileName,
    size: 1000,
    mimeType: fileName.endsWith('.aab') ? 'application/octet-stream' : 'image/png',
    sha256: `sha-${counter}`,
    validation: { errors: [], warnings: [] },
    ...extra,
  };
}

/** An application that satisfies `validateApplication(..., {level:'ready'})`. */
export function readyApp(overrides = {}) {
  return createApplication({
    metadata: { appName: 'Acme Notes', packageName: 'com.acme.notes', defaultLanguage: 'en-US', appOrGame: 'app', pricing: 'free' },
    storeListing: {
      title: 'Acme Notes',
      shortDescription: 'Fast, private notes.',
      fullDescription: 'Acme Notes keeps your notes on your device.',
      category: 'Productivity',
      supportEmail: 'support@acme.com',
      supportWebsite: 'https://acme.com',
      supportPhone: '',
      privacyPolicyUrl: 'https://acme.com/privacy',
      promoVideoUrl: '',
    },
    assets: {
      folderName: 'acme-notes',
      appIcon: assetRef('app-icon.png', { width: 512, height: 512 }),
      featureGraphic: assetRef('feature-graphic.png', { width: 1024, height: 500 }),
      phoneScreenshots: [assetRef('phone-01.png'), assetRef('phone-02.png')],
      tablet7Screenshots: [],
      tablet10Screenshots: [],
    },
    appContent: {
      containsAds: false,
      appAccess: 'all_available',
      declarations: { policiesAccepted: true, exportLawsAccepted: true },
    },
    release: {
      aabFile: assetRef('release.aab', { bundle: { packageName: 'com.acme.notes', versionCode: 1 } }),
      releaseTrack: 'internal',
      releaseNotes: 'First release.',
      versionCode: 1,
    },
    ...overrides,
  });
}
