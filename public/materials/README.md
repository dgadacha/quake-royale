# Matériaux haute définition

Ce dossier reçoit les packs de matériaux qui remplacent les textures d'origine.
Il est ignoré par git à l'exception de ce fichier : les matériaux sont vos
fichiers, ils ne partent pas dans le dépôt.

## Structure

```
public/materials/
  index.json
  stone_brick_01/
    basecolor.png
    normal.png
    roughness.png
    ao.png
```

## index.json

```json
{
  "basePath": "materials/",
  "materials": [
    {
      "id": "stone_brick_01",
      "baseColor": "stone_brick_01/basecolor.png",
      "normal": "stone_brick_01/normal.png",
      "roughness": "stone_brick_01/roughness.png",
      "ao": "stone_brick_01/ao.png",
      "roughnessValue": 0.85,
      "metalnessValue": 0,
      "normalScale": 0.8,
      "textureScale": 1,
      "surface": "stone"
    }
  ],
  "assign": {
    "brick1": "stone_brick_01"
  }
}
```

`assign` associe un nom de texture d'origine à un matériau. Une texture absente
de cette table garde la sienne : une carte peut donc être convertie
progressivement, surface par surface, sans jamais être cassée.

Aucune carte n'est obligatoire dans un matériau. Ce qui manque est comblé par
la texture d'origine ou par les valeurs scalaires.

## Résolutions conseillées

Décors principaux 1024, surfaces vues de près 2048, petits éléments 512.
Le 4K généralisé coûte trop cher dans un navigateur.

## Jeu de démonstration

`node tools/make-test-materials.mjs` écrit ici deux matériaux calculés par le
code, affectés aux textures de la carte de test. Ils servent à vérifier que le
remplacement fonctionne, pas à décorer un niveau.
