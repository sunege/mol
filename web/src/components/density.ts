/**
 * The words of the electron-density buttons: which surfaces are offered, and
 * what each one is showing.
 *
 * Three, and they are named for what the user would see rather than for how it
 * is computed (requirement F4): nothing here says orbital, basis or functional.
 *
 * - すべての電子 — the total density, which is what a molecule's size looks like.
 * - 結合に寄与する電子 — the sharper picture of where the bonds are, which only
 *   the engine can pick: the pi system for a flat molecule, and otherwise the
 *   same deformation density as the third button. Offered only where there is a
 *   pi system to show ({@link offeredChannels}), because where there is not it
 *   is the third button under another name.
 * - 原子から動いた電子 — the deformation density, by name. Every molecule has
 *   one, and for a flat molecule it is the only way to reach it: the bonding
 *   request would always be answered with the pi system.
 *
 * The line under the slider follows what came back rather than what was asked
 * for, because the bonding request is answered two different ways and they look
 * nothing alike - one is a density, the other is signed and drawn in two
 * colours.
 *
 * A fourth request exists in the contract - one orbital - and is deliberately
 * not one of these: it is not a set of electrons at all, and it belongs to the
 * orbital section, which is closed by default and has words of its own
 * (`components/orbital.ts`). Nothing in this file mentions it, which is also
 * what lets the test below forbid the word.
 */
import type { DensityChannel, DensityRequest, IsoMesh } from '../worker/protocol';

/** A request for a density: every one there is except the single orbital. */
export type DensitySurface = Exclude<DensityRequest, 'orbital'>;

/** The surfaces in the order the panel shows them. */
const REQUEST_ORDER: readonly DensitySurface[] = ['total', 'bonding', 'deformation'];

/** What is shown until the user asks for something else. */
export const DEFAULT_REQUEST: DensitySurface = 'total';

const LABELS: Record<DensitySurface, string> = {
  total: 'すべての電子',
  bonding: '結合に寄与する電子',
  deformation: '原子から動いた電子',
};

export function channelLabel(request: DensitySurface): string {
  return LABELS[request];
}

/**
 * The line under each choice's label: what pressing it shows, short enough for
 * one line of the panel. The line under the slider (`explainChannel`) is the
 * longer account of what is on screen now.
 *
 * The bonding one cannot say which of its two answers it will get, and does
 * not need to: it is offered only where there is a pi system, so it always says
 * what the pi picture is for.
 */
const CHANNEL_NOTES: Record<DensitySurface, string> = {
  total: '分子全体を包む電子の広がり',
  bonding: '結合をかたちづくる電子だけ',
  deformation: '結合で濃く・薄くなったところ',
};

export function channelNote(request: DensitySurface): string {
  return CHANNEL_NOTES[request];
}

/**
 * The buttons to show for a molecule, given whether it has a pi system.
 *
 * `hasPi` is false whenever the answer is not known - a molecule nobody has
 * calculated yet, or one that has just been edited - so the bonding button
 * appears only once the engine has said there is something behind it. The
 * deformation density is always there: any molecule has one.
 */
export function offeredChannels(hasPi: boolean): readonly DensitySurface[] {
  return REQUEST_ORDER.filter((request) => request !== 'bonding' || hasPi);
}

const WORDS: Record<Exclude<DensityChannel, 'orbital'>, string> = {
  total: 'しきい値を下げると分子全体を包む形に、上げると原子核や結合のまわりに残ります。',
  pi: '平らな分子なので、面から上下にはみ出している電子だけを表示しています。二重結合や環がある分子で、結合がどこに広がっているかが見えます。',
  deformation:
    '原子がばらばらだったときと比べて、電子が濃くなった場所（青）と薄くなった場所（赤）です。青が結合のできたところにあたります。',
};

/**
 * The deformation density's words once an atom carries a charge (v7). The
 * reference is then the separated atoms and ions as placed, so an ion with no
 * electrons of its own - H+ - is an empty place the molecule's electrons flow
 * into, and shows blue however it bonded. Said here so that blue is not read
 * as a bond on its own.
 */
const DEFORMATION_WITH_IONS =
  '置いた原子やイオンがばらばらだったときと比べて、電子が濃くなった場所（青）と薄くなった場所（赤）です。H⁺ のように電子を持たないイオンのまわりは、流れ込んだ電子で青くなります。';

/**
 * The line under the slider, which has to explain what is on screen without
 * naming a single orbital or functional (requirement F4).
 *
 * Only the bonding request has anything to wait for. The other two are
 * answered one way, so they can be explained before the first surface arrives;
 * that one is not, and until it comes back all that can honestly be said is
 * what was asked for.
 *
 * `hasIons` (any atom on screen carries a charge, `ion.ts`'s `hasIons`) changes
 * only the deformation density's words; left out, it is the neutral wording.
 */
export function explainChannel(
  request: DensitySurface,
  mesh: IsoMesh | null,
  hasIons = false,
): string {
  const deformation = hasIons ? DEFORMATION_WITH_IONS : WORDS.deformation;
  if (request === 'total') return WORDS.total;
  if (request === 'deformation') return deformation;
  const shown: DensityChannel | null = mesh?.channel ?? null;
  if (shown === 'pi') return WORDS.pi;
  if (shown === 'deformation') return deformation;
  return '原子が結びついたことで動いた電子だけを表示します。';
}
