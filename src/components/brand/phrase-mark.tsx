import { Bird } from "@phosphor-icons/react/dist/ssr/Bird";
import { BookOpenText } from "@phosphor-icons/react/dist/ssr/BookOpenText";
import { Plant } from "@phosphor-icons/react/dist/ssr/Plant";
import { brandMarks, type BrandMarkId } from "@/lib/brand-marks";

const icons = { Bird, BookOpenText, Plant };

export function PhraseMark({ variant = "nest", size = 44, className }: { variant?: BrandMarkId; size?: number; className?: string }) {
  const mark = brandMarks.find(item => item.id === variant) ?? brandMarks[0];
  const Icon = icons[mark.icon];
  return <Icon size={size} weight={mark.weight} className={className} aria-hidden="true" focusable="false" data-brand-mark={mark.id} />;
}
