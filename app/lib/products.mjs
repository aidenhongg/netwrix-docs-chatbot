// Loads the canonical product manifest (docs/src/config/products.js) — the very
// same file the documentation site is generated from — so the chatbot's view of
// products, versions, categories and URLs never drifts from the real site.

import { pathToFileURL } from 'node:url';
import { PRODUCTS_CONFIG } from '../config.mjs';

let _mod = null;

async function load() {
  if (_mod) return _mod;
  _mod = await import(pathToFileURL(PRODUCTS_CONFIG).href);
  return _mod;
}

// Mirrors versionToUrl() in products.js: dots become underscores; current/saas pass through.
export function versionToUrl(version) {
  if (version === 'current' || version === 'saas') return version;
  return String(version).replace(/\./g, '_');
}

export async function getProducts() {
  const { PRODUCTS } = await load();
  return PRODUCTS;
}

export async function getCategories() {
  const { PRODUCT_CATEGORIES } = await load();
  return PRODUCT_CATEGORIES || [];
}

// Build fast lookup structures used throughout ingestion.
export async function buildIndex() {
  const { PRODUCTS } = await load();
  const byId = new Map();
  for (const p of PRODUCTS) {
    const versions = (p.versions || []).map((v) => ({
      version: v.version,
      label: v.label || v.version,
      isLatest: !!v.isLatest,
      kbSource: v.kbSource || null,
    }));
    const versionSet = new Set(versions.map((v) => v.version));
    const latest =
      versions.find((v) => v.isLatest) ||
      versions.find((v) => v.version === p.defaultVersion) ||
      versions[0] ||
      null;
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description || '',
      path: p.path || `docs/${p.id}`,
      categories: p.categories || [],
      versions,
      versionSet,
      defaultVersion: p.defaultVersion || (latest && latest.version) || 'current',
      latestVersion: latest ? latest.version : 'current',
    });
  }
  return byId;
}

// Resolve a markdown file path (relative to docs/docs) into structured metadata.
// Returns { isKB, product, productName, version, isLatestVersion, sectionParts,
//           slugParts, kbProduct, kbCategoryParts, url }.
export function classifyPath(relParts, index) {
  // relParts: e.g. ['auditor','10.6','accessreviews','accessreviews.md']
  const top = relParts[0];
  const fileName = relParts[relParts.length - 1];
  const baseName = fileName.replace(/\.(md|mdx)$/i, '');

  if (top === 'kb') {
    // kb/<product>/<category...>/<article>.md
    const kbProduct = relParts[1] || 'unknown';
    const middle = relParts.slice(2, -1); // category path
    // KB versioned overrides like 'accessanalyzer-2601' map back to a product id.
    const productId = kbProduct.replace(/-\d+$/, '');
    const prod = index.get(productId) || index.get(kbProduct) || null;
    return {
      isKB: true,
      product: productId,
      productName: prod ? prod.name : kbProduct,
      version: null,
      isLatestVersion: false,
      sectionParts: middle,
      slugParts: [...relParts.slice(1, -1), baseName],
      kbProduct,
      kbCategoryParts: middle,
      baseName,
      url: `/kb/${relParts.slice(1, -1).join('/')}/${baseName}`,
    };
  }

  const prod = index.get(top) || null;
  let version = null;
  let rest = relParts.slice(1, -1);
  const maybeVersion = relParts[1];
  if (prod && prod.versionSet.has(maybeVersion)) {
    version = maybeVersion;
    rest = relParts.slice(2, -1);
  } else if (prod) {
    version = prod.defaultVersion;
  }
  const isLatest = prod ? version === prod.latestVersion : false;
  const urlVersion = version ? versionToUrl(version) : '';
  const urlBase = prod ? prod.path : `docs/${top}`;
  const url = `/${[urlBase, urlVersion, ...rest, baseName].filter(Boolean).join('/')}`;

  return {
    isKB: false,
    product: top,
    productName: prod ? prod.name : top,
    version,
    isLatestVersion: isLatest,
    sectionParts: rest,
    slugParts: [version, ...rest, baseName].filter(Boolean),
    kbProduct: null,
    kbCategoryParts: [],
    baseName,
    url,
  };
}

export default { getProducts, getCategories, buildIndex, classifyPath, versionToUrl };
