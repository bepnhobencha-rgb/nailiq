import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
export default {
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/|[\/]src[\/])shared[\/]noshow[\/](?:noShowFeeApprovalActions|lateCancellationFeeApprovalActions|groupCancellationFeeApprovalActions|cancellationFeeDispatchActions)(?:\.ts)?$/,
      path.join(fixture, "actions.ts"),
    ));
    return config;
  },
};
