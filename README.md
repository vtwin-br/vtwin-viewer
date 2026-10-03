# Vista 4D (vtwin) — visualizador e editor openBIM

Aplicação web para **abrir, editar e exportar** a hierarquia nativa do IFC.
O 4D (tempo) e o 5D (custo) são os primeiros módulos: a simulação usa o
cronograma que já está no ficheiro (`IfcWorkPlan` / `IfcWorkSchedule` /
`IfcTask` / `IfcTaskTime` e ligações aos produtos), tipicamente exportado
pelo **Bonsai (BlenderBIM)** ou criado na própria app.

A visão do produto, o contrato «grava no STEP ou é rascunho» e o mapa de
entidades estão em **[SOLUCAO.md](SOLUCAO.md)**. Este README explica como
correr o projeto e o que a UI faz hoje.

## Demonstração rápida

```bash
npm install      # instala dependências e copia WASM + 4D.ifc para public/
npm run dev      # abre http://localhost:5173
```

Requer **Node 18+**. O ficheiro de demo `4D.ifc` deve estar na raiz do
repositório; o script `postinstall` copia-o para `public/` se ainda não
existir lá. Em desenvolvimento, `http://localhost:5173/?ifc=/4D.ifc`
abre esse modelo automaticamente.

## O que a aplicação faz

- Abre um ou vários **`.ifc`**, ou um pacote de projeto **`.vtwin`** (ZIP
  com membros federados, cache `.frag`, índice STEP e snapshot do
  cronograma). `Ctrl+O` / soltar ficheiros no ecrã.
- **`Ctrl+S`** (ou o ícone de disquete) guarda o **projeto** `.vtwin`, com o IFC e com `planning/site.json`.
  **`Ctrl+Shift+S`**, ou «Pacote só malha» no menu dos modelos, guarda o
  mesmo pacote **sem** os ficheiros `.ifc` (só malha `.frag`, índice e
  snapshot) para enviar ao cliente. **Exportar IFC** gera o STEP para
  Bonsai/Revit — não substitui o pacote de projeto. Um `.vtwin` só malha
  não traz o STEP; exportar exige o IFC canónico ainda guardado localmente.
- Federação: cada disciplina mantém o seu STEP. A app cria um IFC de
  coordenação (`COORD.ifc`, IFC4, sem malha de obra) dono do
  `IfcWorkPlan`, custo 5D, canteiro e georref de projeto. A ligação
  3D↔tarefa entre ficheiros é o **GlobalId**.
- Substitui a revisão de um IFC e recasa produtos pelo GlobalId
  (ligações noutro ficheiro ficam na COORD).
- Converte geometria para **Fragments** ([That Open Components](https://docs.thatopen.com/));
  cache IndexedDB versionado + bytes IFC em OPFS.
- Lê e escreve o cronograma nativo via patches STEP (`web-ifc` na
  leitura; `IfcSession` na escrita):
  - `IfcWorkPlan` / `IfcWorkSchedule` → plano e cronograma
  - `IfcTask` + `IfcRelNests` → WBS
  - `IfcTaskTime` (IFC4) ou `IfcScheduleTimeControl` (IFC2X3) → datas
  - `IfcRelSequence` + folga → predecessoras FS/SS/FF/SF
  - `IfcRelAssignsToProduct` / `IfcRelAssignsToProcess` → task ↔ 3D
  - `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue` → 5D
  - `IfcPropertySet` / `IfcPropertySingleValue` e
    `IfcClassificationReference` → propriedades e classificação
  - `IfcDocumentReference` → documentos e folhas (o PDF ou `.mpp` do
    Gantt grava a referência; o `.mpp` binário não é lido)
  - `IfcTable` → tabelas, com um `IfcDocumentReference` do mesmo nome
  - `IfcRelContainedInSpatialStructure` / `IfcRelAggregates` → mover na
    árvore espacial
  - `IfcGroup` `VISTA4D_SEARCH` + `Pset_Vista4dSearch` → search set
  - `IfcRelInterferesElements` (IFC4) → interferência gravada
- Menu principal só de planejamento (`src/app/catalog.ts`), no mesmo
  `IfcSession` (trocar de ferramenta não descarrega o modelo):
  - **4D** — simulação no viewport, timeline, HUD 5D, Google Photorealistic
    3D Tiles, caminhada em 1.ª pessoa
  - **Gantt** — editor das mesmas `IfcTask` (datas, WBS, predecessoras,
    conjuntos, ligação ao 3D, coluna Custo)
  - **Logística** — guindaste, caminho, terreno e anotação. `Ctrl+S` grava os parâmetros em `planning/site.json` dentro do `.vtwin`. Exportar IFC não os escreve no STEP
- Fora do menu, ainda no mesmo `IfcSession`: Dashboard, Visualizador,
  Documentação, Editor e Coordenação (`IfcRelInterferesElements`). BCF
  (tópico, câmara, markup) fica de fora do IFC.
- Estados 4D nos produtos com data: **pendente** oculto, **em execução**
  amarelo (`#F59E0B`), **concluído** cor original. Volumes espaciais sem
  tarefa ficam ocultos; o resto da construção permanece como contexto.

## Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl+O` | Abrir `.ifc` / `.vtwin` |
| `Ctrl+S` | Guardar projeto `.vtwin` |
| `Ctrl+Shift+S` | Guardar pacote só malha (sem os IFC) |
| `V` | (4D / Logística) modo voo / orbit vs caminhada, conforme o workspace |

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | Vite em http://localhost:5173 |
| `npm run build` | `tsc --noEmit` + bundle de produção |
| `npm run preview` | Serve o build |
| `npm run test:ifc-session` | Valida patches STEP da sessão |
| `npm run benchmark:ifc` | Benchmark de parse IFC |
| `npm run benchmark:import` | Benchmark de importação Fragments |

## Estrutura

```
src/
├─ main.ts                 # bootstrap, abrir/guardar, simulação, atalhos
├─ app/catalog.ts          # módulos visíveis no menu
├─ bim/                    # contratos semânticos e refs GUID
├─ ifc/
│  ├─ ifcSession.ts        # única porta de escrita STEP
│  ├─ modelSet.ts          # federação de vários IFC
│  ├─ coordination.ts      # cria/sementeia COORD.ifc
│  ├─ coordinationIfc.ts   # STEP mínimo IFC4 (Project + Site)
│  ├─ scheduleWrite.ts     # serialize WorkPlan / Task / RelSequence / custo
│  ├─ semanticWrite.ts     # pset, classificação, documento, tabela, contenção
│  ├─ stepStore.ts         # bytes IFC em OPFS
│  └─ fragCache.ts         # cache IndexedDB de .frag
├─ project/                # pacote .vtwin (manifesto, ZIP, recase de GUID)
├─ schedule/               # leitura 4D/5D, ligações, simulação, custo
├─ projectPlan/            # vista Gantt e import CSV/XML → IfcTask
├─ logistics/              # limite de canteiro no IfcSite
├─ viewer/                 # viewport, highlight, tiles, 1.ª pessoa
└─ ui/                     # shell, Gantt, logística, camadas, HUD
```

## Notas técnicas

- O WASM do `web-ifc` é servido em `/wasm/` (copiado de `node_modules/web-ifc/`).
- A thread principal não mantém a string STEP integral: o export worker lê o
  IFC do OPFS, aplica o `IfcChangeSet` e gera uma nova revisão.
- `modelId + GlobalId` liga o domínio semântico à geometria; `localId` fica
  no adaptador Fragments. Entre ficheiros **não** se usam `#expressId` cruzados.
- `.vtwin` **não** substitui o IFC: é cache de sessão (membros + `.frag` +
  índice). A entrega interoperável continua a ser `.ifc`.
- O `4D.ifc` de demo foi gerado pelo Bonsai (`IfcOpenShell`) e já contém
  `IfcWorkPlan` / `IfcWorkSchedule` / `IfcTask` / `IfcRelSequence`.
