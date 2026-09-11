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
arquivo IFC exportado (`Ctrl+S` / Exportar IFC).

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
| Canónico (contrato BIM) | **IFC-SPF (`.ifc`)** | Importar, editar, exportar. Fonte da verdade. |
| Arquivo / envio | `.ifcZIP` | Compressão do mesmo STEP. |
| Visualização 3D | **Fragments** (That Open) | Runtime no viewport; não substitui o IFC. |
| Índice interno (futuro) | SQLite ou similar | Queries rápidas; **derivado** do IFC, não o substitui. |
| API (futuro) | ifcJSON | Troca web entre serviços; o ficheiro mestre continua `.ifc`. |

Não adotar ifcXML, HDF5 ou “IFC só em SQL” como formato mestre. SQLite, se
vier, é índice para escala — o utilizador continua a receber e a entregar `.ifc`.

---

## 4. Módulos atuais (UI)

A shell está em `src/app/catalog.ts`. Menu em dois níveis: domínio (1.º nível) e
ferramenta / workspace (2.º nível). Um domínio com uma só ferramenta aparece
como entrada direta.

| Domínio | Ferramentas | Estado |
|---|---|---|
| Dashboard | Dashboard | Placeholder — indicadores + interação 3D |
| Visualizador | Visualizador | Placeholder — vista 3D dedicada |
| Documentação | Documentação | Placeholder — documentos, folhas 2D, tabelas (`IfcDocumentReference`, etc.) |
| Planejamento e Orçamento | Cronograma 4D · Planejamento de projeto · Logística | 4D/Gantt ativos; Logística em placeholder |
| Coordenação | Coordenação | Placeholder — BCF, clash |
| Editor | Editor | Placeholder — modelagem IFC |

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
IfcRelSequence                      predecessoras
IfcDocumentReference                documentos associados (leitura)
```

### Já nativo (lê e/ou grava no STEP)

| Capacidade | Entidades / relações | Escrita no export |
|---|---|---|
| Abrir cronograma do IFC | `IfcWorkPlan`, `IfcWorkSchedule`, `IfcTask`, `IfcRelNests` | — (leitura) |
| Criar cronograma se o IFC não tiver | `IfcWorkPlan`, `IfcWorkSchedule`; IFC4: `IfcRelDeclares`; IFC2X3: sem RelDeclares | Sim |
| Tarefa nova no Gantt | `IfcTask`; IFC4: `IfcTaskTime`; IFC2X3: `IfcScheduleTimeControl` + `IfcRelAssignsTasks`; `IfcRelNests` / `IfcRelAssignsToControl` | Sim |
| Apagar tarefa (e subtarefas) | comenta `IfcTask` / `IfcTaskTime` / `IfcRelSequence` e atualiza ninhos | Sim |
| Datas, nome e WBS | IFC4: `IfcTaskTime`, `Identification`; IFC2X3: `IfcCalendarDate` / `IfcDateAndTime`, `TaskId` | Sim |
| CSV / XML Project | mapeador de colunas → as mesmas entidades (casa por WBS/nome; cria o resto) | Sim |
| Predecessores na importação | `IfcRelSequence` | Sim (import); leitura no Gantt |
| Ligar/desligar elemento 3D à tarefa | `IfcRelAssignsToProduct` (Bonsai) | Sim |
| Conjuntos tipo Navis («Estacas») | `IfcGroup` (`ObjectType = VISTA4D_SET`), `IfcRelAssignsToGroup`, `IfcRelAssignsToProcess` | Sim |
| Custo 5D em tarefa existente | `IfcCostItem`, `IfcCostValue`, `IfcRelAssignsToControl` | Sim |
| Georreferência / extra de posição | `IfcSite`, `IfcMapConversion`, … | Sim |
| Simulação 4D no viewport | calculada a partir de datas + GUIDs | — |

Código de escrita: `src/ifc/ifcSession.ts` (patches STEP; o resto do ficheiro
fica intacto). Leitura do cronograma: `src/schedule/parseSchedule.ts`.
O Gantt (`src/ui/projectWorkspace.ts`) é uma **vista** desse grafo, não um segundo plano.

### Ainda rascunho (UI sim, IFC não)

| Capacidade | Onde vive hoje | O que falta no STEP |
|---|---|---|
| % de progresso na barra do Gantt | só visual | `IfcTaskTime` não tem %; não inventar propriedade |
| `.mpp` binário / PDF no Gantt | aviso na sessão | XML/CSV para tarefas; documentos → `IfcDocumentReference` |
| Árvore espacial | Fragments `getSpatialStructure()` | Edição de `IfcRelContainedInSpatialStructure` / agregação |
| Search sets por propriedade | — | `IfcGroup` + query; ainda não há |
| Indentação / predecessoras no Gantt | hierarquia na criação/import | editar `IfcRelNests` / `IfcRelSequence` à mão no ecrã |

Cada linha do Gantt é uma `IfcTask`. Sem modelo IFC aberto não há cronograma para editar.

---

## 6. Como o 4D e o 5D se encaixam

Não são bases de dados à parte. São **vistas** sobre o mesmo grafo:

- **4D** — a data da simulação classifica cada `IfcTask` (pendente / em
  execução / concluído) e aplica isso aos `IfcProduct` ligados (ocultar,
  amarelo, cor original).
- **5D** — `IfcCostItem` / `IfcCostValue` ligados à mesma tarefa; o HUD
  acumula no tempo.
- **Conjuntos** — `IfcGroup` nomeado; ligar o grupo à tarefa expande os
  membros para a simulação e grava as relações no STEP.

Um IFC só com geometria (sem `IfcWorkSchedule`) abre o 3D; o Gantt cria o
cronograma nativo no próprio ficheiro (ou importa CSV/XML para `IfcTask`).

---

## 7. Arquitetura de runtime (hoje)

```
.ifc (SPF)
  ├─ web-ifc          → ScheduleData (tarefas, custos, grupos, georef)
  ├─ IfcLoader        → Fragments (malha 3D)
  └─ IfcSession       → texto STEP em memória + patches no export
           ↓
UI (módulos)  ←→  IfcModelSet (vários IfcSession) / modelos 3D visíveis
```

- Uma sessão = um ficheiro IFC. A vista pode **federar vários** (cada um com o seu `IfcSession` / STEP).
- Ligar/desligar um IFC filtra o 3D, o cronograma 4D, o Gantt, os custos 5D e os gráficos — só entram os modelos visíveis.
- GlobalId liga cronograma (web-ifc) à geometria (Fragments).
- Não persistir estado da app em `localStorage` como substituto do IFC
  (preferências de UI podem; o modelo BIM não).

---

## 8. Ficheiros de referência

| Ficheiro | Responsabilidade |
|---|---|
| `src/app/catalog.ts` | Módulos visíveis no menu |
| `src/ifc/ifcSession.ts` | Única porta de **escrita** STEP |
| `src/ifc/stepText.ts` | Parse/serialize de entidades STEP |
| `src/schedule/parseSchedule.ts` | Leitura nativa 4D/5D/grupos |
| `src/schedule/types.ts` | `Task`, `SelectionGroup`, `ScheduleData` |
| `src/ifc/scheduleWrite.ts` | Serialize de `IfcWorkSchedule` / `IfcTask` / `IfcRelNests` / `IfcRelSequence` |
| `src/projectPlan/` | Vista Gantt e mapeamento CSV/XML → outline IFC |
| `src/viewer/` | Viewport, highlight, caixa de seleção |
| `4D.ifc` | Modelo de demo (Bonsai / IfcOpenShell), cronograma já no ficheiro |

---

## 9. Demo `4D.ifc`

O cronograma que aparece ao abrir este arquivo **já estava no IFC** (não é
inventado pela app): `IfcWorkPlan` «Engineering and Construction»,
`IfcWorkSchedule` «EC», WBS `DCP-*`, `IfcTaskTime`, ligações 3D estilo Bonsai.

---

## 10. Próximos passos alinhados com este guia

Ordem sugerida, sempre com export verificável:

1. Indentação e predecessoras editáveis no Gantt (`IfcRelNests`, `IfcRelSequence`).
2. Propriedades e classificação nativas (`IfcPropertySet`, `IfcClassificationReference`).
3. Documentos do Gantt como `IfcDocumentReference` (hoje PDF/.mpp ficam só na sessão).
4. Índice SQLite derivado, se a escala exigir — sem abandonar o `.ifc`.
