import { ApiReference } from '@scalar/nextjs-api-reference';

export const GET = ApiReference({
  url: '/api/openapi',
  title: 'Owlette API Reference',
  theme: 'kepler',
  darkMode: true,
  hideDownloadButton: false,
  metaData: {
    title: 'Owlette API Reference',
    description: 'Interactive API documentation for the Owlette fleet management platform',
  },
});
