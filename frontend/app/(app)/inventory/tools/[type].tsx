import { useLocalSearchParams } from "expo-router";
import { EquipmentScreen } from "../equipment";

export default function ToolTypeInventoryScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  return <EquipmentScreen initialView="tools" toolType={type} />;
}
