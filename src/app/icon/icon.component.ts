import { CommonModule } from "@angular/common";
import { Component, Input } from "@angular/core";

type IconName =
  | "play"
  | "square"
  | "refresh-cw"
  | "refresh-ccw"
  | "star"
  | "chevron-down"
  | "bold"
  | "italic"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "list"
  | "list-ordered"
  | "minus"
  | "pilcrow";

interface IconDefinition {
  viewBox: string;
  paths: string[];
}

const ICONS: Record<IconName, IconDefinition> = {
  "play": {
    viewBox: "0 0 24 24",
    paths: ["M6 3l14 9-14 9V3z"],
  },
  "square": {
    viewBox: "0 0 24 24",
    paths: ["M6 6h12v12H6z"],
  },
  "refresh-cw": {
    viewBox: "0 0 24 24",
    paths: [
      "M21 12a9 9 0 1 1-3.2-6.9",
      "M21 3v6h-6",
    ],
  },
  "refresh-ccw": {
    viewBox: "0 0 24 24",
    paths: [
      "M3 12a9 9 0 1 0 3.2-6.9",
      "M3 3v6h6",
    ],
  },
  "star": {
    viewBox: "0 0 24 24",
    paths: [
      "M12 3.7l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.7 1-5.8L3.6 9.8l5.8-.8L12 3.7z",
    ],
  },
  "chevron-down": {
    viewBox: "0 0 24 24",
    paths: ["M6 9l6 6 6-6"],
  },
  "bold": {
    viewBox: "0 0 24 24",
    paths: [
      "M6 4h8a4 4 0 0 1 0 8H6z",
      "M6 12h9a4 4 0 0 1 0 8H6z",
    ],
  },
  "italic": {
    viewBox: "0 0 24 24",
    paths: [
      "M19 4h-9",
      "M14 20H5",
      "M15 4L9 20",
    ],
  },
  "heading-1": {
    viewBox: "0 0 24 24",
    paths: [
      "M4 12h8",
      "M4 18V6",
      "M12 18V6",
      "M18 12l2-2v8",
    ],
  },
  "heading-2": {
    viewBox: "0 0 24 24",
    paths: [
      "M4 12h8",
      "M4 18V6",
      "M12 18V6",
      "M17 10a2 2 0 1 1 4 0c0 2-3 3-4 6h4",
    ],
  },
  "heading-3": {
    viewBox: "0 0 24 24",
    paths: [
      "M4 12h8",
      "M4 18V6",
      "M12 18V6",
      "M18 10a2 2 0 1 1 2 2",
      "M20 12a2 2 0 1 1-2 2",
    ],
  },
  "list": {
    viewBox: "0 0 24 24",
    paths: [
      "M8 6h13",
      "M8 12h13",
      "M8 18h13",
      "M3 6h.01",
      "M3 12h.01",
      "M3 18h.01",
    ],
  },
  "list-ordered": {
    viewBox: "0 0 24 24",
    paths: [
      "M10 6h11",
      "M10 12h11",
      "M10 18h11",
      "M4 10V6l-1 1",
      "M4 18H2c0-1 2-2 2-3a1 1 0 0 0-2 0",
    ],
  },
  "minus": {
    viewBox: "0 0 24 24",
    paths: ["M5 12h14"],
  },
  "pilcrow": {
    viewBox: "0 0 24 24",
    paths: [
      "M13 4v16",
      "M17 4v16",
      "M19 4H9a4 4 0 0 0 0 8h8",
    ],
  },
};

@Component({
  selector: "app-icon",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./icon.component.html",
  styleUrl: "./icon.component.css",
})
export class IconComponent {
  @Input({ required: true }) name!: IconName;
  @Input() size = 18;
  @Input() strokeWidth = 2;

  icon(): IconDefinition | null {
    return ICONS[this.name] ?? null;
  }
}
