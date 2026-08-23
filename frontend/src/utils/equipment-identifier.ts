export type EquipmentIdentifier = {
  qr_code?: string | null;
  sku?: string;
  category?: string;
};

/** Operator-facing identity. SKU stays internal for compatibility and test IDs. */
export const qrCodeDisplay = (equipment: EquipmentIdentifier) => equipment.qr_code?.trim() || "Not assigned";

export const equipmentIdentifier = (equipment: EquipmentIdentifier) => {
  const qrCode = equipment.qr_code?.trim();
  if (qrCode) return `QR ${qrCode}`;
  return "QR not assigned";
};
