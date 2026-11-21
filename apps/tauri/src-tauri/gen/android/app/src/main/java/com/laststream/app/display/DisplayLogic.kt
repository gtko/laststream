package com.laststream.app.display

/** Logique pure de la détection de l'écran : choix de la sortie la plus fine annoncée, testée sans appareil. */
object DisplayLogic {
    /** Une sortie vidéo en pixels physiques. */
    data class Output(val width: Int, val height: Int) {
        val valid: Boolean get() = width > 0 && height > 0
        val shortSide: Int get() = minOf(width, height)
    }

    /**
     * Sortie à retenir parmi celles que le système annonce (mode d'affichage courant d'abord, taille réelle de l'écran ensuite) :
     * la plus fine valable. Une box Android TV peut dessiner l'interface en 1080p tout en sortant en 4K : la WebView n'en voit
     * que le 1080p, le mode d'affichage dit la vérité.
     */
    fun best(vararg candidates: Output?): Output? = candidates.filterNotNull().filter { it.valid }.maxByOrNull { it.shortSide }
}
