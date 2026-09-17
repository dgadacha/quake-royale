# Quake HD

Moteur de rendu haute définition écrit en TypeScript et Three.js, capable de
charger et d'afficher les cartes, textures et modèles du jeu d'origine.

Le dépôt ne contient aucune donnée du jeu. Le moteur lit les fichiers que vous
possédez déjà sur votre machine, ou fonctionne sans eux grâce à une arène de
démonstration générée par le code.

## Démarrer

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:5212.

Au lancement, deux voies :

- **Arène de démonstration** : ne demande aucun fichier. Géométrie, textures et
  éclairage sont produits par le code au chargement.
- **Vos données** : déposez un `.pak` ou un `.bsp` sur la zone prévue, ou placez
  vos fichiers dans `public/data` (voir plus bas).

## Monter vos données

Deux méthodes, au choix.

**Par glisser-déposer.** Depuis l'écran d'accueil, déposez un ou plusieurs
fichiers `.pak`, ou directement une carte `.bsp`. Les archives montées en
dernier ont la priorité, comme dans le jeu d'origine.

**Depuis le disque.** Copiez vos fichiers dans `public/data`, puis déclarez-les
dans `public/data/manifest.json` :

```json
{
  "paks": ["pak0.pak", "pak1.pak"],
  "maps": ["maps/e1m1.bsp"],
  "files": ["progs/armor.mdl"]
}
```

`pak0.pak` à `pak2.pak` sont montés automatiquement s'ils sont présents, même
sans manifeste. Le dossier `public/data` est ignoré par git : vos fichiers ne
partent jamais dans le dépôt.

Pour afficher les objets d'une carte, associez les noms d'entités à des modèles
dans `public/data/entities.json` :

```json
{ "item_armor1": "progs/armor.mdl" }
```

Une entrée dont le fichier est absent est ignorée sans erreur.

## Ce que fait le moteur

**Formats lus**

- Archives `PAK`, avec système de fichiers virtuel multi-archives
- Cartes `BSP` version 29 : géométrie, textures internes, lightmaps, entités,
  volumes de collision, arbre de visibilité
- Modèles animés `MDL` version 6, peaux simples et groupées
- Palette `palette.lmp`, avec détection des couleurs non affectées par
  l'éclairage

**Rendu**

- Agrandissement des textures par détection de contours sur les indices de
  palette, ce qui supprime les marches d'escalier sans flouter le dessin
- Carte de relief et carte de rugosité déduites de chaque texture, plus un grain
  de proximité qui casse l'aspect plat des surfaces agrandies
- Lightmaps empilées dans des atlas, quatre styles d'animation par surface,
  torches et néons animés par des motifs générés
- Direction de la lumière reconstruite depuis la pente de la lightmap : le
  relief des normales réagit à l'éclairage réel de la carte
- Couleurs non affectées par l'éclairage traitées en émissif, avec halo
- Ciel à deux couches défilantes, eau, lave et téléporteurs déformés par shader
- Chaîne de post-traitement en flottant : halo lumineux, tonemapping ACES,
  vignette, grain, teinte et ondulation en immersion

**Déplacement**

Reprise fidèle du modèle d'origine : accélération au sol et en l'air, friction,
vitesse maximale de 320 unités par seconde, gravité 800, saut de 270, marches
franchies jusqu'à 18 unités, nage. L'accélération en l'air étant plafonnée sur
la vitesse visée et non sur la vitesse réelle, on dépasse la vitesse maximale en
tournant pendant un enchaînement de sauts, exactement comme à l'origine.

La collision utilise les volumes précalculés de la carte, par descente
récursive dans l'arbre, avec glissement le long des surfaces et franchissement
automatique des marches.

## Outils

Deux générateurs produisent des données de test, ce qui permet d'exercer les
parseurs sans aucun fichier extérieur :

```bash
node tools/make-test-bsp.mjs   # salle BSP v29 complète, avec ciel et entités
node tools/make-test-mdl.mjs   # modèle animé quatre images
```

Les fichiers sont écrits dans `public/data` et déclarés dans le manifeste.

## Mise au point

Ouvrir la page avec `?dev` expose `window.qhd` dans la console :

```js
qhd.state()                                   // position, vitesse, contact au sol
qhd.teleport(0, -480, 40)
qhd.look(Math.PI / 2, -0.4)                   // orientation, en radians
qhd.simulate({ seconds: 2, forward: 1 })      // avance la physique à pas fixes
qhd.props()                                   // état d'animation des modèles
qhd.level()                                   // compteurs de la carte chargée
```

`simulate` avance la simulation par pas fixes indépendamment de l'affichage :
un comportement de déplacement se vérifie sans avoir à le jouer à la main.

<kbd>F3</kbd> masque les compteurs en jeu.

## Structure

```
src/formats/    lecture des fichiers : pak, bsp, mdl, palette
src/render/     textures, lightmaps, matériaux, shaders, post-traitement
src/game/       collision, physique, joueur, niveaux, arène de démonstration
src/dev/        harnais de mise au point
tools/          générateurs de données de test
assets/         modèles d'armes au format glTF binaire
```

## Limites connues

- Les portes, plateformes et ascenseurs sont affichés à leur position fermée
  mais ne bougent pas encore
- Pas d'armes, d'ennemis ni de son
- L'arbre de visibilité de la carte est lu mais pas encore exploité pour
  écarter les surfaces hors champ

## Licence et données

Le code de ce dépôt est original. Les formats de fichiers ont été implémentés à
partir de leurs définitions publiques.

Les données du jeu (cartes, textures, modèles, sons) appartiennent à leurs
ayants droit, ne sont pas fournies ici et ne doivent pas être redistribuées.
Utilisez les fichiers de la copie du jeu que vous possédez.

Les modèles du dossier `assets` sont fournis séparément et restent soumis à leur
propre licence.
