import { Award, GraduationCap, Handshake, Heart, Lightbulb, Rocket, Star, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

const ICONS: Record<string, LucideIcon> = { handshake: Handshake, rocket: Rocket, lightbulb: Lightbulb, heart: Heart, "graduation-cap": GraduationCap, star: Star, award: Award };

/** A praise badge: icon in a soft accent circle. Unknown icon keys fall back to a rosette. */
export function BadgeIcon({ icon, size = "md", className }: { icon: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = ICONS[icon] ?? Award;
  const s = { sm: "size-7 [&_svg]:size-3.5", md: "size-10 [&_svg]:size-5", lg: "size-14 [&_svg]:size-7" }[size];
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent-text", s, className)}>
      <Icon />
    </span>
  );
}
