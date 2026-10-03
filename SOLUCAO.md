# Vista 4D — guia da solução

Este documento é o contrato da plataforma. Qualquer módulo, ecrã ou integração
tem de ser compatível com o que está aqui. O `README.md` explica como correr o
projeto; **aqui explica o que o produto é**.

Atualizar este ficheiro quando mudar a visão, o mapa IFC ou o que já grava no
STEP — não quando mudar um botão ou um estilo.

---

## 1. O que é

A Vista 4D é um **visualizador e editor openBIM da hierarquia nativa do IFC**,
multiplataforma (hoje web).

O 4D (tempo) e o 5D (custo) são os primeiros módulos. Não são o produto. O
produto é editar **toda a estrutura IFC** — espacial, produtos, tipos,
propriedades, cronograma, custos, documentos, georreferência, conjuntos — e
devolver um `.ifc` que outro software openBIM (Bonsai, Revit, Navisworks, etc.)
abre sem um formato paralelo nosso.

O IFC não é um ficheiro de importação. **É o modelo de dados da aplicação.**

---

## 2. Regra de ouro (o que “entra” na plataforma)

Se o utilizador faz algo na UI e considera isso **gravado**, tem de existir no
arquivo IFC exportado (**Exportar IFC**). `Ctrl+S` guarda o pacote de projeto
(`.vtwin`) — atalho de sessão, não o formato mestre.

Antes de implementar uma funcionalidade, responder:

1. **Em que entidade IFC isto vive?** (`IfcTask`, `IfcGroup`, `IfcCostValue`, …)
2. **Em que relação IFC se liga ao resto?** (`IfcRelNests`, `IfcRelAssignsToProduct`, …)
3. **O export STEP preserva isto?** Abrir o `.ifc` noutro programa confirma.

| Resultado | Classificação |
|---|---|
| Sim às três | Funcionalidade da plataforma |
| Só existe no ecrã / JSON / sessão | **Rascunho** — útil para trabalhar, não é “salvo no modelo” |
| Não há entidade IFC adequada | Não inventar um esquema nosso; ou não fazer, ou mapear para o IFC mais próximo |

Cores da simulação 4D, hover e câmara **não** precisam de entidade: são vistas
calculadas sobre dados que já estão no IFC (datas da `IfcTaskTime`, GUIDs dos
produtos).

---

## 3. Formatos

O IFC é um **esquema**. A troca oficial mais usada é o **STEP Physical File**
(`.ifc`, ISO 10303-21). Ver [formatos buildingSMART](https://technical.buildingsmart.org/standards/ifc/ifc-formats/).

| Camada | Formato | Papel |
|---|---|---|
| Canónico (contrato BIM) | **IFC-SPF (`.ifc`)** | Importar, editar, exportar. Fonte da verdade. Cada disciplina no seu ficheiro. |
| Pacote de projeto | **`.vtwin`** (ZIP) | Um clique: membros federados + `.frag` + índice + snapshot do cronograma. Não substitui o IFC. |
| Pacote só malha | **`.vtwin`** com `meshOnly` | O mesmo pacote sem os STEP (`model.ifc`). Serve para entregar a malha ao cliente. Sem o IFC canónico local, não há Exportar IFC. |
| Arquivo / envio | `.ifcZIP` | Compressão do mesmo STEP. |
| Visualização 3D | **Fragments** (That Open) | Runtime no viewport; cache IndexedDB e cópia dentro do `.vtwin`. |
| Índice interno | Manifesto + offset STEP + GUID + snapshot semântico; bytes IFC em **OPFS** | Cache quente, queries e export; **derivado** do IFC, não o substitui. |
| API (futuro) | ifcJSON | Troca web entre serviços; o ficheiro mestre continua `.ifc`. |

Não adotar ifcXML, HDF5, `.frag` ou “IFC só em SQL” como formato mestre.
O utilizador continua a receber e a entregar `.ifc`. `Ctrl+S` guarda o **projeto** (`.vtwin`); `Ctrl+Shift+S` (ou «Pacote só malha» no menu dos modelos) guarda o mesmo pacote sem os STEP. **Exportar IFC** gera o STEP para Bonsai/Revit (incluindo `COORD.ifc` / `{projeto}-coordenacao.ifc` quando há raiz). Cache Fragments / OPFS / `.vtwin` podem apagar-se — a app volta a converter a partir do STEP.

A federação tem um IFC de coordenação (`COORD.ifc`, IFC4, sem malha de obra): dono do `IfcWorkPlan` / tarefas / custo / canteiro / georref de projeto. As disciplinas ficam com a geometria. A ligação 3D↔tarefa entre ficheiros é o **GlobalId** (não um `#expressId` cruzado). No export da disciplina, a app escreve um `IfcTask` stub com o mesmo GlobalId da raiz e `IfcRelAssignsToProduct` para os produtos locais. O manifesto `.vtwin` grava `rootId` e `role: coordination` nesse membro (pode ir sem `.frag`).

---

## 4. Módulos atuais (UI)

A shell está em `src/app/catalog.ts`. O menu principal é a árvore de
planejamento. Dashboard, Visualizador, Documentação, Editor e Coordenação
continuam no código e no mesmo `IfcSession`, fora dessa navegação.

| No menu | Ferramenta | Estado |
|---|---|---|
| Planejamento | 4D | Relatório e simulação no viewport |
| Planejamento | Gantt | Editor `IfcTask` |
| Planejamento | Logística | Quatro peças (grua, camião, betoneira, vedação). Cada instância grava `IfcBuildingElementProxy` + `IfcElementQuantity` na `IfcTask`. A biblioteca não entra no IFC |

| Fora do menu | Estado |
|---|---|
| Dashboard | Indicadores calculados (tarefas, estados pela data, custo, elementos ligados) |
| Visualizador | Vista 3D do viewport já aberto — não há segundo modelo |
| Documentação | `IfcDocumentReference` (documento e folha) e `IfcTable` |
| Coordenação | `IfcRelInterferesElements` (IFC4). BCF fica fora |
| Editor | `IfcPropertySet`, classificação, contenção/agregação, search set |
| Limite | Limite de canteiro (`IfcAnnotation`). Fora do menu deste corte |

O ficheiro IFC em memória (`IfcSession`) é o mesmo em todos os módulos. Trocar
de módulo não descarrega o modelo.

Novos domínios entram no catálogo da mesma forma. `placeholder: true` reserva o
sítio no menu sem UI de trabalho.

---

## 5. Mapa IFC (o que lemos e o que escrevemos)

Hierarquia típica que a app já trata:

```
IfcProject
  └─ IfcWorkPlan                    plano de trabalhos
       └─ IfcWorkSchedule           cronograma
            └─ IfcTask              WBS / atividade  (IfcRelNests / IfcRelAssignsToControl)
                 ├─ IfcTaskTime     datas (IFC4)
                 ├─ IfcScheduleTimeControl + IfcRelAssignsTasks   datas (IFC2X3)
                 ├─ IfcProduct      3D via IfcRelAssignsToProduct (Bonsai) ou IfcRelAssignsToProcess
                 ├─ IfcGroup        conjunto 4D (IfcRelAssignsToGroup + ligação à tarefa)
                 └─ IfcCostItem     5D (IfcCostValue, IfcRelAssignsToControl)
IfcSite / IfcMapConversion          georreferência
IfcAnnotation VISTA4D_SITE_LIMIT    limite de canteiro (polilinha + Pset de recorte)
IfcRelSequence                      predecessoras (FS/SS/FF/SF + folga)
IfcDocumentReference                documentos e folhas (Identification = número da folha)
IfcTable / IfcTableColumn / IfcTableRow   tabelas; o IfcDocumentReference homónimo liga o nome ao projeto
IfcPropertySet / IfcRelDefinesByProperties  propriedades no elemento
IfcClassificationReference          classificação (IfcRelAssociatesClassification)
IfcRelContainedInSpatialStructure   produto dentro de IfcSite / Building / Storey / Space
IfcRelAggregates                    agregação entre elementos espaciais
IfcGroup VISTA4D_SEARCH             search set; a consulta está em Pset_Vista4dSearch.Query
IfcRelInterferesElements            interferência gravada (IFC4)
IfcBuildingElementProxy VISTA4D_SITE_ASSET   equipamento de canteiro (caixa) + IfcLocalPlacement
IfcElementQuantity Qto_Vista4dSiteAsset  contagem, comprimento e volume do equipamento
IfcRelAssignsToProduct              o equipamento ligado à IfcTask da fase
COORD.ifc (federação)               IfcProject + IfcSite; WorkPlan/Task/custo/canteiro/documentos
Disciplina no export                IfcTask stub (mesmo GlobalId) + IfcRelAssignsToProduct
```

A app cria a COORD na primeira edição de Gantt, 5D, logística ou ao guardar `.vtwin`. Se uma disciplina já tiver `IfcTask`, esse grafo é copiado para a raiz (os STEP de origem não são apagados). Com raiz presente, o Gantt e a simulação 4D leem só o cronograma da COORD; o highlighter resolve GUIDs em todos os Fragments visíveis.

### Já nativo (lê e/ou grava no STEP)

| Capacidade | Entidades / relações | Escrita no export |
|---|---|---|
| Abrir cronograma do IFC | `IfcWorkPlan`, `IfcWorkSchedule`, `IfcTask`, `IfcRelNests` | — (leitura) |
| Criar cronograma se o IFC não tiver | `IfcWorkPlan`, `IfcWorkSchedule`; IFC4: `IfcRelDeclares`; IFC2X3: sem RelDeclares | Sim |
| Tarefa nova no Gantt | `IfcTask`; IFC4: `IfcTaskTime`; IFC2X3: `IfcScheduleTimeControl` + `IfcRelAssignsTasks`; `IfcRelNests` / `IfcRelAssignsToControl` | Sim |
| Apagar tarefa (e subtarefas) | comenta `IfcTask` / `IfcTaskTime` / `IfcRelSequence` e atualiza ninhos | Sim |
| Datas, nome e WBS | IFC4: `IfcTaskTime`, `Identification`; IFC2X3: `IfcCalendarDate` / `IfcDateAndTime`, `TaskId` | Sim |
| Arrastar / redimensionar barras | as mesmas datas `IfcTaskTime` | Sim |
| Ligações FS / SS / FF / SF + folga | `IfcRelSequence`, `IfcLagTime` (IFC4) ou `IfcTimeMeasure` (IFC2X3) | Sim |
| CSV / XML Project | mapeador de colunas (inclui custo) → as mesmas entidades (casa por WBS/nome; cria o resto) | Sim |
| Predecessores na importação | `IfcRelSequence` | Sim (import); leitura no Gantt |
| Ligar / desligar / editar predecessoras no Gantt | `IfcRelSequence` + `IfcLagTime` | Sim |
| Ligar/desligar elemento 3D à tarefa | `IfcRelAssignsToProduct` (Bonsai); GUID noutro ficheiro fica só na COORD | Sim (rel na disciplina no export) |
| IFC de coordenação | `COORD.ifc` IFC4 (`IfcProject` + `IfcSite`), `role: coordination` no `.vtwin` | Sim |
| Pacote de projeto | `.vtwin` (ZIP: STEP + `.frag` + índice + snapshot); `rootId` no manifesto | — (sessão) |
| Pacote só malha | o mesmo ZIP sem `model.ifc` (`meshOnly` no manifesto); `Ctrl+Shift+S` ou «Pacote só malha» | — (sessão; não é o mestre) |
| Substituir revisão IFC | recase pelo GlobalId (`src/project/rematch.ts`); órfãos noutro ficheiro na COORD | — |
| Conjuntos tipo Navis («Estacas») | `IfcGroup` (`ObjectType = VISTA4D_SET`), `IfcRelAssignsToGroup`, `IfcRelAssignsToProcess` | Sim |
| Custo 5D na coluna do Gantt | `IfcCostSchedule` (BUDGET), `IfcCostItem`, `IfcCostValue`, `IfcRelAssignsToControl` à `IfcTask` | Sim |
| Georreferência / extra de posição | `IfcSite`, `IfcMapConversion`, … | Sim |
| Limite de canteiro | `IfcAnnotation` (`ObjectType = VISTA4D_SITE_LIMIT`) + `IfcPolyline` + `Pset_Vista4dSiteLimit`; `IfcRelContainedInSpatialStructure` no `IfcSite` | Sim |
| Recorte Google / platô | vista (shader + malha) sobre o polígono e a cota gravados | — |
| Simulação 4D no viewport | calculada a partir de datas + GUIDs | — |
| Propriedade num elemento | `IfcPropertySingleValue` dentro de `IfcPropertySet`; `IfcRelDefinesByProperties` | Sim |
| Classificação | `IfcClassification` + `IfcClassificationReference` + `IfcRelAssociatesClassification` | Sim |
| Documento ou folha 2D | `IfcDocumentReference` + `IfcRelAssociatesDocument` (folha = a mesma entidade, com Identification). PDF/.mpp no Gantt gravam a referência (nome e localização); o binário .mpp não é lido | Sim |
| Tabela | `IfcTable`, `IfcTableColumn`, `IfcTableRow` (IFC2X3: sem colunas, linha de cabeçalho). O esquema não liga `IfcTable` ao `IfcProject`; a app acrescenta um `IfcDocumentReference` com o mesmo Name e Description `IfcTable` | Sim |
| Mover na árvore espacial | produto → `IfcRelContainedInSpatialStructure`; elemento espacial → `IfcRelAggregates` | Sim |
| Search set | `IfcGroup` (`ObjectType = VISTA4D_SEARCH`) + membros `IfcRelAssignsToGroup` + consulta em `Pset_Vista4dSearch` / `Query` (`Tipo=IfcWall` ou `Pset.Prop=valor`) | Sim |
| Interferência | `IfcRelInterferesElements` (IFC4). Dois GlobalId; se estiverem em ficheiros diferentes, a relação fica na COORD com proxies | Sim |
| Equipamento de canteiro | `IfcBuildingElementProxy` (`ObjectType = VISTA4D_SITE_ASSET`) + caixa `IfcExtrudedAreaSolid` + `IfcElementQuantity` (`Count`, `Length`, `Volume`) + `IfcRelAssignsToProduct` à fase | Sim. A malha reconhecível (grua, camião…) é vista do `Tag`; o STEP leva a caixa, a posição e as quantidades |

Código de escrita: `src/ifc/ifcSession.ts` (patches STEP; o resto do ficheiro
fica intacto). Leitura do cronograma: `src/schedule/parseSchedule.ts`.
O Gantt (`src/ui/projectWorkspace.ts`) é uma **vista** desse grafo, não um segundo plano.

### Não entra no STEP

| Capacidade | Onde vive hoje | O que falta no STEP |
|---|---|---|
| % de progresso na barra do Gantt | só visual | `IfcTaskTime` não tem %; não inventar propriedade |
| Tópicos BCF, câmara, markup, vista do clash | — | Não há entidade IFC para o tópico BCF nem para a câmara. A câmara é vista calculada. O par de elementos, quando o utilizador o grava, é `IfcRelInterferesElements` — não um `.bcf` nosso |
| Varredura automática de clash | não está na UI | Não há ficheiro de clash. O par que o utilizador grava é `IfcRelInterferesElements` |

Cada linha do Gantt é uma `IfcTask`. Sem modelo IFC aberto não há cronograma para editar.

---

## 6. Como o 4D, o Gantt e o 5D se encaixam

Não são bases de dados à parte. São **vistas** sobre o mesmo grafo IFC:

- **4D** — relatório e visualização do resultado. A data da simulação classifica
  cada `IfcTask` (pendente / em execução / concluído) e aplica isso aos
  `IfcProduct` ligados (ocultar, amarelo, cor original). Google Earth, caminhada
  em 1ª pessoa, linha do tempo e HUD 5D vivem aqui. O inspector é só leitura;
  a edição do cronograma não é nesta ferramenta.
- **Gantt** — planejador e editor das mesmas `IfcTask` (datas, WBS, predecessoras,
  conjuntos, ligação ao 3D, **custo 5D**). O valor da coluna Custo fica na
  tarefa e portanto nos mesmos produtos/conjuntos já ligados. Sem simulação,
  terreno ou caminhada. O viewport 3D, quando aberto, é pré-visualização BIM.
- **Logística** — limite de intervenção no `IfcSite` (polígono + cota). O Google
  Photorealistic 3D Tiles é recortado em prisma nesse polígono; o platô é vista
  sobre a mesma curva. Terreno e caminhada estão disponíveis. Equipamento e
  rotas ainda não.
- **5D** — `IfcCostItem` / `IfcCostValue` ligados à mesma tarefa (coluna Custo
  do Gantt ou inspector); o HUD da ferramenta 4D acumula no tempo. A primeira
  edição cria `IfcCostSchedule` na COORD.
- **Conjuntos** — `IfcGroup` nomeado; ligar o grupo à tarefa no Gantt expande os
  membros para a simulação 4D e grava as relações no STEP.

Um IFC só com geometria (sem `IfcWorkSchedule`) abre o 3D; o Gantt cria o
cronograma nativo no próprio ficheiro (ou importa CSV/XML para `IfcTask`).

---

## 7. Arquitetura de runtime (hoje)

```
.vtwin (ZIP de sessão)  — manifesto + models/<id>/{model.ifc, model.frag, index, schedule}
        ↓ abrir
.ifc (SPF)  — ficheiro canónico, em OPFS enquanto a sessão está aberta
  ├─ IfcLoader / cache .frag versionado  → Fragments (malha + perfil semântico)
  ├─ snapshot / índice expressId+GUID     → ScheduleData e queries lazy
  └─ IfcSession + IfcChangeSet            → alterações canónicas; export em worker
           ↓
UI (módulos)  ←→  IfcModelSet (COORD + disciplinas) / modelos 3D visíveis
```

- Uma sessão = um ficheiro IFC. A vista pode **federar vários** (COORD + disciplinas, cada um com o seu `IfcSession` / STEP).
- Substituir um IFC (revisão) recasa produtos pelo GlobalId; órfãos noutro ficheiro ficam na COORD.
- O cache é identificado por hash do IFC + versão do pipeline + perfil semântico.
- Cache quente: abre `.frag` + snapshot sem preparar STEP nem executar `OpenModel`.
- A thread principal não mantém a string STEP integral. O export worker lê o IFC
  original do OPFS, aplica o `IfcChangeSet`, valida a estrutura STEP e gera uma
  nova revisão/hash.
- Disciplina oculta: a malha Fragments sai da VRAM; o IFC fica em OPFS e volta pelo cache `.frag`.
- Ligar/desligar um IFC filtra o 3D, o cronograma 4D, o Gantt, os custos 5D e os gráficos — só entram os modelos visíveis.
- `modelId + GlobalId` liga o domínio semântico à geometria; `localId` fica
  restrito ao adaptador Fragments.
- A simulação 4D só altera produtos com datas; volumes espaciais sem tarefa
  (`IfcSpace`, ambientes, aberturas, anotações) ficam ocultos. O resto da
  construção sem data permanece como contexto.
- Não persistir estado da app em `localStorage` como substituto do IFC
  (preferências de UI podem; o modelo BIM não).

### Backend

A aplicação continua **local-first/offline**. Um backend não é requisito de
openBIM e não melhora o FPS depois do modelo carregado. Só deve ser introduzido
se os benchmarks de hardware-alvo exigirem tirar do cliente a primeira conversão
IFC → Fragments, ou se vários utilizadores precisarem compartilhar os mesmos
artefatos. Nesse caso o serviço executa o mesmo pipeline e publica apenas
artefatos derivados; o IFC continua sendo a fonte e a saída interoperável.

---

## 8. Ficheiros de referência

| Ficheiro | Responsabilidade |
|---|---|
| `src/app/catalog.ts` | Módulos visíveis no menu |
| `src/ifc/ifcSession.ts` | Única porta de **escrita** STEP |
| `src/ifc/coordination.ts` | Cria e sementeia `COORD.ifc` a partir das disciplinas |
| `src/ifc/coordinationIfc.ts` | STEP mínimo IFC4 (`IfcProject` + `IfcSite`) |
| `src/ifc/modelSet.ts` | Federação (raiz + disciplinas, visibilidade, refs) |
| `src/ifc/stepText.ts` | Parse/serialize de entidades STEP |
| `src/ifc/stepIndex.ts` | Índice expressId / GlobalId / tipo |
| `src/ifc/stepStore.ts` | Bytes IFC em OPFS |
| `src/ifc/fragCache.ts` | Cache IndexedDB de `.frag` + cronograma |
| `src/project/` | Pacote `.vtwin` (manifesto, ZIP, recase de GUID) |
| `src/schedule/parseSchedule.ts` | Leitura nativa 4D/5D/grupos |
| `src/schedule/links.ts` | FS/SS/FF/SF, folga e recálculo à frente |
| `src/schedule/types.ts` | `Task`, `SelectionGroup`, `ScheduleData` |
| `src/ifc/scheduleWrite.ts` | Serialize de `IfcWorkSchedule` / `IfcTask` / `IfcRelNests` / `IfcRelSequence` |
| `src/ifc/semanticWrite.ts` | Pset, classificação, documento, tabela, contenção, search set, interferência |
| `src/ui/moduleWorkspace.ts` | Vistas Dashboard, Visualizador, Documentação, Editor e Coordenação |
| `src/projectPlan/` | Vista Gantt e mapeamento CSV/XML → outline IFC |
| `src/logistics/` | Limite de canteiro (parse/serialize `IfcAnnotation`) |
| `src/viewer/` | Viewport, highlight, caixa de seleção, recorte Google |
| `src/ui/logisticsWorkspace.ts` | Painel do módulo Logística |
| `4D.ifc` | Modelo de demo (Bonsai / IfcOpenShell), cronograma já no ficheiro |

---

## 9. Demo `4D.ifc`

O cronograma que aparece ao abrir este arquivo **já estava no IFC** (não é
inventado pela app): `IfcWorkPlan` «Engineering and Construction»,
`IfcWorkSchedule` «EC», WBS `DCP-*`, `IfcTaskTime`, ligações 3D estilo Bonsai.

---

## 10. Fora do STEP (de propósito)

- **BCF** (tópico, comentário, câmara, markup) não é gravado. Não existe entidade IFC equivalente e um `.bcf` paralelo seria um segundo mestre. A interferência que o utilizador confirma grava-se como `IfcRelInterferesElements`.
- **% de progresso** continua só na barra do Gantt. `IfcTaskTime` não tem esse campo.
- **Pacote só malha** não contém o STEP. Abrir esse `.vtwin` mostra a malha e o snapshot; Exportar IFC só funciona se o IFC canónico ainda estiver no armazenamento local.
- **`.mpp` binário** não é interpretado. O que se grava é a referência (`IfcDocumentReference`), não as tarefas. Tarefas entram por XML ou CSV.
- **Apresentação ao cliente** (esconder o menu e reproduzir as fases) é uma vista. A câmara não entra no STEP.
- **Malha da biblioteca de canteiro** (grua, camião, etc.) é uma vista. O STEP grava a caixa, a posição, o `Tag` e as quantidades.
