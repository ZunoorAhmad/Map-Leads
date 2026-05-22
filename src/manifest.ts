const mapsHostPermissions = [
  'https://google.com/maps/*',
  'https://www.google.com/maps/*',
  'https://*.google.com/maps/*',
  'https://maps.google.com/*',
]

const manifest = {
  manifest_version: 3,
  name: 'Google Maps Exporter',
  version: '1.0.0',
  description: 'Scrape visible Google Maps business details on demand.',
  action: {
    default_title: 'Google Maps Exporter',
    default_popup: 'index.html',
    default_icon: {
      16: 'icons/icon.svg',
      32: 'icons/icon.svg',
      48: 'icons/icon.svg',
      128: 'icons/icon.svg',
    },
  },
  permissions: ['activeTab', 'scripting', 'downloads'],
  host_permissions: mapsHostPermissions,
  content_scripts: [
    {
      matches: mapsHostPermissions,
      js: ['assets/content.js'],
      run_at: 'document_idle',
    },
  ],
  background: {
    service_worker: 'assets/background.js',
    type: 'module',
  },
  icons: {
    16: 'icons/icon.svg',
    32: 'icons/icon.svg',
    48: 'icons/icon.svg',
    128: 'icons/icon.svg',
  },
} as const

export default manifest