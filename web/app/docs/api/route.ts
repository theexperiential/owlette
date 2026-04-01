import { ApiReference } from '@scalar/nextjs-api-reference';

export const GET = ApiReference({
  url: '/api/openapi',
  title: 'owlette API Reference',
  theme: 'kepler',
  darkMode: true,
  hideDownloadButton: false,
  metaData: {
    title: 'owlette API Reference',
    description: 'Interactive API documentation for the owlette fleet management platform',
  },
});
