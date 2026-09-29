# Guide de l’équipe

Cette documentation est construite par MkDocs Material. Les images et scripts du site sont servis localement.

## Vue d’ensemble

```plantuml
@startuml
actor Auteur
component LuCiDoc
component Kroki
database "Volume des sites" as Data
Auteur --> LuCiDoc : Markdown / AsciiDoc
LuCiDoc --> Kroki : source du diagramme
LuCiDoc --> Data : HTML + SVG
@enduml
```

Consultez aussi [le guide de contribution](contributing.html).
