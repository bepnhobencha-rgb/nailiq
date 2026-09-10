import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixture = path.dirname(fileURLToPath(import.meta.url));
const config = {
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/|[\\/]src[\\/])shared[\\/]observability[\\/]errorReporter(?:\.ts)?$/,
      path.join(fixture, 'reporter.ts'),
    ));
    return config;
  },
};

export default config;
