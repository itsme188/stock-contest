import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["imapflow", "better-sqlite3", "@stoqey/ib", "nodemailer"],
};

export default nextConfig;
