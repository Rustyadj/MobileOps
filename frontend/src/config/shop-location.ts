import type { Pin } from "@/src/components/MapCanvas";

export const DEFAULT_SHOP = {
  name: "ICF Connection Shop / Yard",
  address: "1586 Seaborn Dr, Ponder, TX 76259",
  lat: 33.1622357,
  lng: -97.2596744,
} as const;

export type SiteWithShop = {
  company_address?: string;
  shop_lat?: number;
  shop_lng?: number;
};

export function shopPin(site?: SiteWithShop | null): Pin {
  return {
    id: "icf-connection-shop-yard",
    lat: site?.shop_lat ?? DEFAULT_SHOP.lat,
    lng: site?.shop_lng ?? DEFAULT_SHOP.lng,
    title: DEFAULT_SHOP.name,
    subtitle: site?.company_address || DEFAULT_SHOP.address,
    status: "shop",
  };
}
