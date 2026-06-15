import { Helmet } from 'react-helmet-async';

/**
 * SEO 头部（对标 Klook/携程 详情页可分享元信息）。
 * 设置 <title>、description、Open Graph（og:title/description/image）、canonical，
 * 以及可选 JSON-LD 结构化数据（如 Product / BreadcrumbList）。
 * 纯展示：所有内容走 props。
 *
 * 依赖 react-helmet-async（由另一 agent 安装并在根部包 HelmetProvider）。
 */
export interface SeoProps {
  title: string;
  description?: string;
  image?: string;
  /** 站内路径（如 "/bundles/abc"），用于 canonical；建议绝对化由部署层处理。 */
  canonicalPath?: string;
  /** 结构化数据对象，原样序列化进 <script type="application/ld+json">。 */
  jsonLd?: object;
}

const SITE_NAME = 'Citur Travel · 海岛专线';

export function Seo({ title, description, image, canonicalPath, jsonLd }: SeoProps) {
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
  const canonical =
    canonicalPath && typeof window !== 'undefined'
      ? new URL(canonicalPath, window.location.origin).toString()
      : canonicalPath;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      {description && <meta name="description" content={description} />}

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      {description && <meta property="og:description" content={description} />}
      {image && <meta property="og:image" content={image} />}
      {canonical && <meta property="og:url" content={canonical} />}

      {/* Twitter */}
      <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
      {image && <meta name="twitter:image" content={image} />}

      {canonical && <link rel="canonical" href={canonical} />}

      {jsonLd && <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>}
    </Helmet>
  );
}
