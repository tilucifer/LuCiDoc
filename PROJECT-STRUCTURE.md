# Structure recommandée

```text
LuCiDoc/
├── docker-compose.yml              # agrégateur, PDF, Kroki + réseau interne
├── Dockerfile                      # Node.js, MkDocs Material, Reveal.js, Asciidoctor
├── requirements.txt                # MkDocs et son thème, versions figées
├── package.json                    # bibliothèques locales de l’agrégateur
├── src/
│   ├── server.js                   # API, bibliothèque, thèmes, jobs SSE, lecteur
│   ├── library.js                  # découverte et validation des .meta
│   ├── renderer.js                 # MkDocs, Reveal et conversion Kroki
│   └── public/                     # interface sans CDN
├── pdf/
│   ├── Dockerfile                  # Chromium + Puppeteer Core
│   ├── package.json
│   └── src/server.js               # capture fidèle des pages servies
├── content/                        # source locale montée en lecture seule
│   ├── engineering-talk/
│   │   ├── .meta
│   │   └── slides.md
│   └── team-handbook/
│       ├── .meta
│       ├── index.md
│       └── contributing.adoc
├── templates/                      # templates intégrés copiés au premier lancement
│   ├── default/template.json
│   └── default/theme.css
├── scripts/
│   ├── aggregator-entrypoint.sh     # prépare les volumes puis lance le serveur/build
│   └── import-template.sh           # copie un template dans le volume persistant
├── README.md
└── PROJECT-STRUCTURE.md
```

Le volume `sites` reçoit les sites préparés, le volume `exports` reçoit les PDF, et le volume `templates` devient la bibliothèque persistante lue par le sélecteur. Le répertoire `templates/` de l’image contient uniquement les templates initiaux : l’entrypoint les copie dans le volume s’ils n’y sont pas déjà. Le répertoire `content/` est un exemple remplaçable par `CONTENT_DIR`.
