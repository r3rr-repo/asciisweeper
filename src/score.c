#include "score.h"

void score_flags(const Board *b, const FlagState flags[MAX_H][MAX_W], int out[2])
{
    out[0] = out[1] = 0;
    for (int y = 0; y < b->h; y++) {
        for (int x = 0; x < b->w; x++) {
            const FlagState *fs = &flags[y][x];
            bool mine = b->cells[y][x].mine;

            if (fs->reverser != 0) {
                int rev = fs->reverser - 1;
                if (mine) {
                    /* They overruled a correct call: it costs them, and the
                     * player who got it right is still credited. */
                    out[rev] -= 2;
                    if (fs->flagger != 0)
                        out[fs->flagger - 1] += 1;
                } else {
                    out[rev] += 2;
                }
            } else if (fs->flagger != 0) {
                out[fs->flagger - 1] += mine ? 1 : -1;
            }
        }
    }
}
