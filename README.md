# LuCiDoc

LuCiDoc réunit des présentations Reveal.js et des sites documentaires MkDocs dans un lecteur local. Les sources sont lues depuis un dossier hôte monté en lecture seule. Les sites construits, les exports PDF et les templates d’entreprise sont conservés dans des volumes Docker nommés.

## Démarrage

1. Copiez `.env.example` vers `.env` et ajustez `CONTENT_DIR` si les sources ne sont pas dans `./content`.
2. Construisez les images puis démarrez les services :

   ```sh
   docker compose build
   docker compose up -d
   ```

3. Ouvrez [http://localhost:8080](http://localhost:8080). Le premier lancement génère automatiquement les contenus valides. Le bouton **Tout générer** relance le build et affiche son avancement.

Par défaut, le port web est lié à `127.0.0.1`. Pour accéder au lecteur depuis d’autres postes, configurez `WEB_BIND` et placez un contrôle d’accès réseau devant le service.

## Hors ligne et réseau

Après la construction et le chargement de toutes les images, l’interface, MkDocs, Reveal.js, les styles, Chromium/Puppeteer et Kroki s’exécutent sur des ressources locales, sans CDN. Les services restent sur le réseau Compose `local-only`; seul l’agrégateur rejoint aussi `host-access` pour publier l’interface sur `127.0.0.1:8080`. Le NAT sortant de ce second réseau est désactivé. Les diagrammes Markdown/AsciiDoc sont rendus par l’instance Kroki locale pendant le build puis inclus comme SVG dans le site.

La première construction doit récupérer les images Docker et les dépendances npm/Python ainsi que les paquets Debian de Chromium. Pour une machine isolée, construisez les images sur une machine connectée, transférez les images obtenues puis chargez-les dans Docker (`docker save` / `docker load`). Le registre peut être remplacé via `KROKI_IMAGE` et `KROKI_MERMAID_IMAGE`; en entreprise, figer les images autorisées par tag immuable ou digest puis les précharger dans le cache Docker.

## Sources et identification

Le dossier racine est choisi par `CONTENT_DIR`. Chaque sous-dossier de premier niveau contient un fichier `.meta` strict au format clé-valeur :

```ini
type=presentation
title=Architecture hors ligne
entry=slides.md
```

`type` est obligatoire et vaut `presentation` ou `documentation`. `title` est facultatif. `entry` est obligatoire pour une présentation et désigne son fichier Markdown ou AsciiDoc. Il est interdit de sortir du sous-dossier avec `..`. Pour une documentation, toutes les pages `.md`, `.markdown`, `.adoc` et `.asciidoc` présentes dans l’arborescence sont ajoutées au site MkDocs; `entry` n’est pas accepté.

Les dossiers sans `.meta` valide ou sans source reconnue sont ignorés et signalés dans l’interface. Les liens du site documentaire sont construits par MkDocs. Les dossiers imbriqués à l’intérieur d’un projet documentaire servent à organiser les pages et apparaissent dans sa navigation.

### Présentations

Les fichiers Markdown utilisent les séparateurs Reveal habituels `---`; les fragments Reveal sont disponibles, par exemple `- Point <!-- .element: class="fragment" -->`. Pour un deck AsciiDoc, chaque titre de niveau 2 (`== Titre`) démarre une diapositive. Les bibliothèques Reveal.js, ses styles et son plugin Markdown sont servis depuis l’image agrégateur.

### Diagrammes Kroki

Dans Markdown, utilisez des blocs de code dont la langue est un type Kroki, par exemple `plantuml`, `mermaid`, `graphviz` (`dot` est accepté), `erd`, `ditaa` ou `seqdiag`. En AsciiDoc, la syntaxe est `[plantuml]` ou `[mermaid]`, suivie d’un bloc délimité par `----`. Kroki retourne un SVG au build; il est inclus au site généré. Mermaid est câblé via son conteneur compagnon Kroki.

Les scripts de conversion parcourent les blocs de diagrammes connus; les autres blocs de code restent du code. Vérifiez les dépendances du diagramme retenu dans la documentation Kroki si vous ajoutez un type qui utilise un conteneur compagnon.

## Export PDF

Le bouton **Exporter PDF** appelle le service isolé `pdf`. Celui-ci ouvre l’URL locale du contenu dans Chromium avec le template sélectionné, attend la fin de Reveal/MkDocs, les polices et les images, puis produit le PDF avec les fonds CSS activés. Reveal utilise sa feuille d’impression PDF pour conserver une diapositive par page; MkDocs est imprimé en A4. Le service écrit aussi un exemplaire dans le volume `lucidoc_exports`.

La génération n’accède qu’au lecteur interne. Les requêtes Chromium vers d’autres origines sont bloquées. Les diagrammes étant déjà rendus par Kroki, le PDF ne dépend pas du service Kroki au moment de l’impression.

## Templates d’entreprise

Le sélecteur charge les dossiers présents dans le volume nommé `lucidoc_templates`. Chaque template est un dossier contenant :

```text
mon-theme/
├── template.json
└── theme.css
```

Exemple de `template.json` :

```json
{
  "id": "mon-theme",
  "label": "Entreprise — Bleu",
  "presentationTheme": "black"
}
```

`id` doit correspondre au nom du dossier. `presentationTheme` est un thème Reveal intégré (`black`, `white`, `moon`, `night`, etc.). `theme.css` contient les règles personnalisées communes; il peut cibler les classes Material (`.md-*`) ou Reveal (`.reveal`). Le template doit fournir les deux fichiers et son identifiant doit être unique.

Copiez un dossier local de template dans le volume persistant sans reconstruire les images :

```sh
sh scripts/import-template.sh ./mon-theme mon-theme
```

Le script cible le conteneur `aggregator` en cours d’exécution. Rechargez ensuite la page pour mettre à jour le sélecteur. Les templates sont conservés après `docker compose down`; supprimer le volume `lucidoc_templates` supprime les templates ajoutés.

## Volumes

| Volume | Usage |
| --- | --- |
| `lucidoc_sites` | Sites HTML générés et SVG Kroki |
| `lucidoc_exports` | Copies persistantes des PDF |
| `lucidoc_templates` | Templates par défaut et personnalisés |

L’arborescence de recommandation est celle de ce dépôt : `src/` pour l’agrégateur et l’interface, `pdf/` pour Puppeteer, `content/` pour un exemple de sources, `templates/` pour les templates initiaux et `scripts/` pour les entrypoints/outils d’import.

## Références techniques

- [Compose et les volumes nommés](https://docs.docker.com/reference/compose-file/volumes/)
- [Reveal.js, Markdown et fragments](https://revealjs.com/markdown/)
- [Reveal.js, export PDF](https://revealjs.com/pdf-export/)
- [MkDocs Material](https://squidfunk.github.io/mkdocs-material/)
- [Kroki avec Docker/Compose](https://docs.kroki.io/kroki/setup/use-docker-or-podman/)
- [Kroki, requêtes HTTP POST](https://docs.kroki.io/kroki/setup/usage/)
- [Puppeteer, génération PDF](https://pptr.dev/guides/pdf-generation)
