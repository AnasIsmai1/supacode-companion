/** Box glyphs or several lines mean it is a drawing, not a sentence. */
export const isArt = (v: string) => /[│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝║═]/.test(v) || v.split("\n").length > 2;
