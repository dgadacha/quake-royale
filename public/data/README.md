# Données du jeu

Ce dossier reçoit vos fichiers personnels. Il est ignoré par git, à l'exception
de ce fichier.

Déposez ici vos archives `pak0.pak`, `pak1.pak`, vos cartes dans `maps/` et vos
modèles dans `progs/`, puis déclarez ce qui doit être chargé au démarrage dans
`manifest.json` :

```json
{
  "paks": ["pak0.pak"],
  "maps": ["maps/e1m1.bsp"],
  "files": ["progs/armor.mdl"]
}
```

Les fichiers `pak0.pak` à `pak2.pak` sont montés automatiquement même sans
manifeste.

Les données de test produites par `node tools/make-test-bsp.mjs` et
`node tools/make-test-mdl.mjs` atterrissent également ici.
