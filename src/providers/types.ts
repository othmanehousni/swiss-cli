import type { HttpClient } from '../crawler/http.js';
import type {
  Category,
  NormalizedProduct,
  ProductDetails,
  StoreId,
} from '../normalization/types.js';

export const LANGS = ['de', 'fr', 'it'] as const;
export type Lang = (typeof LANGS)[number];

export interface ProviderContext {
  http: HttpClient;
  lang: Lang;
  /** Only printed with --verbose. */
  debug: (message: string) => void;
}

/** Something to page through: a category, the promotions page, the wine shop... */
export interface ListingSource {
  /** Stable id, used to save progress (checkpoints). */
  key: string;
  /** Shown in progress output. */
  label: string;
  params: Record<string, string>;
}

export type Cursor = string | number | null;

export interface ListingPage {
  products: NormalizedProduct[];
  /** Cursor of the following page; null after the last page. */
  next: Cursor;
  total: number | null;
  /** Items the store returned that could not be understood (API change?). */
  skipped: number;
}

export interface StoreInfo {
  id: StoreId;
  name: string;
  website: string;
  /** What the store publishes online, in plain words. */
  coverage: string;
  /** Most items are weekly offers that change every week. */
  rotating: boolean;
  /** false = the store blocked the build environment, so this provider is untested. */
  verified: boolean;
  /**
   * Product names start with the brand ("Feldschlösschen Bier Original"), so products
   * without a brand field get the published brand their name starts with.
   */
  brandInName?: boolean;
  /** A word for the first search suggested after a fetch, when the store sells no milk. */
  searchExample?: string;
  /** Set when the store is known not to work right now: why, in plain words. */
  unavailable?: string;
  /** Polite default request rate. */
  requestsPerSecond: number;
}

export interface DetailsRequest {
  storeProductId: string;
  sourceRef: Record<string, string>;
  url: string | null;
}

/**
 * One supermarket. The crawler drives every store the same way:
 * categories -> sources -> pages of products -> (optional) details.
 */
export interface Provider {
  info: StoreInfo;
  categories(ctx: ProviderContext): Promise<Category[]>;
  /** What to list: the whole catalog (`categoryIds` = null) or selected categories. */
  sources(categories: Category[], categoryIds: string[] | null): ListingSource[];
  fetchPage(ctx: ProviderContext, source: ListingSource, cursor: Cursor): Promise<ListingPage>;
  /** Ingredients, nutrition, barcode... Absent when the listing already has everything. */
  fetchDetails?(ctx: ProviderContext, request: DetailsRequest): Promise<ProductDetails | null>;
  /**
   * Asks the store whether a product missing from a full crawl still exists.
   * Listings can shift while they are paged through, so products are only marked
   * as removed once the store confirms it. Return false only for "it is gone".
   */
  isStillListed?(ctx: ProviderContext, request: DetailsRequest): Promise<boolean>;
  /** Top-level categories that count as groceries for `--category food`. */
  isFood?(category: Category): boolean;
}
