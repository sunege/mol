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
 * not one of these buttons: it belongs to the orbital section, which is closed
 * by default and has words of its own. It appears below only because the maps
 * here cover every request there is.
 */
import type { DensityChannel, DensityRequest, IsoMesh } from '../worker/protocol';

/**
 * The surfaces in the order the panel shows them, which is every request except
 * the orbital one - that is the orbital section's, not a button here.
 */
const REQUEST_ORDER: readonly DensityRequest[] = ['total', 'bonding', 'deformation'];

/** What is shown until the user asks for something else. */
export const DEFAULT_REQUEST: DensityRequest = 'total';

const LABELS: Record<DensityRequest, string> = {
  total: 'すべての電子',
  bonding: '結合に寄与する電子',
  deformation: '原子から動いた電子',
  orbital: '分子軌道',
};

export function channelLabel(request: DensityRequest): string {
  return LABELS[request];
}

/**
 * The buttons to show for a molecule, given whether it has a pi system.
 *
 * `hasPi` is false whenever the answer is not known - a molecule nobody has
 * calculated yet, or one that has just been edited - so the bonding button
 * appears only once the engine has said there is something behind it. The
 * deformation density is always there: any molecule has one.
 */
export function offeredChannels(hasPi: boolean): readonly DensityRequest[] {
  return REQUEST_ORDER.filter((request) => request !== 'bonding' || hasPi);
}

const WORDS: Record<DensityChannel, string> = {
  total: 'しきい値を下げると分子全体を包む形に、上げると原子核や結合のまわりに残ります。',
  pi: '平らな分子なので、面から上下にはみ出している電子だけを表示しています。二重結合や環がある分子で、結合がどこに広がっているかが見えます。',
  deformation:
    '原子がばらばらだったときと比べて、電子が濃くなった場所（青）と薄くなった場所（赤）です。青が結合のできたところにあたります。',
  orbital:
    '電子の入る部屋を 1 つだけ取り出した形です。色の違いは符号の違いで、電子の濃さではありません。',
};

/**
 * The line under the slider, which has to explain what is on screen without
 * naming a single orbital or functional (requirement F4).
 *
 * Only the bonding request has anything to wait for. The other two are
 * answered one way, so they can be explained before the first surface arrives;
 * that one is not, and until it comes back all that can honestly be said is
 * what was asked for.
 */
export function explainChannel(request: DensityRequest, mesh: IsoMesh | null): string {
  if (request === 'total') return WORDS.total;
  if (request === 'deformation') return WORDS.deformation;
  if (request === 'orbital') return WORDS.orbital;
  const shown: DensityChannel | null = mesh?.channel ?? null;
  if (shown === 'pi' || shown === 'deformation') return WORDS[shown];
  return '原子が結びついたことで動いた電子だけを表示します。';
}
