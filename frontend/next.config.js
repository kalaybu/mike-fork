/** @type {import('next').NextConfig} */
const nextConfig = {
    reactCompiler: true,
    async rewrites() {
        // BACKEND_API_URL is read on the Next.js server at request time, so
        // it can be set via App Service env vars without rebuilding the
        // image. Defaults to localhost for `next dev`.
        const backend = process.env.BACKEND_API_URL ?? "http://localhost:3001";
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
            {
                source: "/api/:path*",
                destination: `${backend}/:path*`,
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

module.exports = nextConfig;
