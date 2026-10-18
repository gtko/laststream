import type { HeroFamily } from './palettes';

export type HeadId = 'oval' | 'square' | 'round' | 'pointed';
export type HairId = 'crop' | 'quiff' | 'spiky' | 'long' | 'sweep' | 'mohawk' | 'afro' | 'bun' | 'buzz' | 'bald' | 'ponytail';
export type MaskId = 'none' | 'wolf' | 'half' | 'full' | 'visor';
export type HeadgearId =
  | 'none' | 'headband' | 'goggles' | 'crest' | 'horns' | 'hood' | 'crown' | 'astro' | 'cyber' | 'antenna'
  | 'greathelm' | 'openhelm' | 'wizhat' | 'archerhood';
export type ArmorId = 'plain' | 'pauldrons' | 'spikes' | 'plate' | 'harness' | 'scales' | 'gorget';
export type CapeId = 'none' | 'cape' | 'highcollar' | 'scarf' | 'fur' | 'turtleneck' | 'cloak';
export type EmblemId =
  | 'bolt' | 'star' | 'flame' | 'wave' | 'diamond' | 'rings' | 'triangle' | 'hexagon' | 'crescent' | 'sparkle'
  | 'chevrons' | 'orbit' | 'blades';
export type AccessoryId = 'none' | 'headset' | 'scar' | 'glasses' | 'shades' | 'earring';
export type MouthId = 'smile' | 'flat' | 'smirk' | 'grin' | 'open';
export type BeardId = 'none' | 'goatee' | 'full';

/** Tous les choix d'un avatar, tirés de la graine, et les couleurs qui en découlent. */
export interface Ctx {
  /** Préfixe d'identifiants SVG unique par avatar (plusieurs SVG peuvent cohabiter dans une même page). */
  id: string;
  fam: HeroFamily;
  kit: string;
  skin: string; skinD: string; skinL: string;
  hair: string; hairD: string; hairL: string;
  main: string; mainD: string; mainL: string;
  sec: string; secD: string; secL: string;
  /** Couleur du masque : celle du costume qui contraste le plus avec la peau. */
  maskC: string;
  acc: string; accD: string;
  steel: string; steelD: string; steelL: string;
  ink: string;
  iris: string;
  neonColor: string;
  head: HeadId;
  hairStyle: HairId;
  mask: MaskId;
  headgear: HeadgearId;
  armor: ArmorId;
  cape: CapeId;
  emblem: EmblemId;
  accessory: AccessoryId;
  mouth: MouthId;
  beard: BeardId;
  neon: boolean;
  angry: boolean;
  backing: boolean;
  fins: boolean;
  elf: boolean;
  android: boolean;
  /** Visage entièrement masqué (heaume, cagoule intégrale) : ni yeux, ni bouche dessinés. */
  covered: boolean;
}
