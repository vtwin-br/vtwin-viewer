# Visualizador Web 4D — IFC

Aplicação web para visualizar arquivos **IFC com simulação 4D** dirigida pelo
**cronograma nativo** do próprio IFC (`IfcWorkSchedule` / `IfcTask` /
`IfcTaskTime` / `IfcRelAssignsToProcess`), tipicamente exportado pelo
**Bonsai (BlenderBIM)**.

## Demonstração rápida

```bash
npm install      # instala dependências e copia WASM + 4D.ifc para public/
npm run dev      # abre http://localhost:5173
```

> Requer **Node 18+**. O arquivo `4D.ifc` deve estar na raiz do projeto
> (`c:\ifc-viewer\4D.ifc`); o script `postinstall` o copia para `public/`.

## O que a aplicação faz

- Carrega o IFC via [`@thatopen/components`](https://docs.thatopen.com/) e
  converte para Fragments (formato binário do That Open Engine).
- Lê **diretamente do IFC** o cronograma 4D usando [`web-ifc`](https://www.npmjs.com/package/web-ifc):
  - `IfcWorkSchedule` → cronograma raiz
  - `IfcTask` + `IfcRelNests` → hierarquia de tarefas
  - `IfcTaskTime` → datas (`ScheduleStart`/`ScheduleFinish`)
  - `IfcRelAssignsToProcess` → ligação **task ↔ produtos 3D**
- Renderiza:
  - **Sidebar** com árvore expansível das tarefas e mini-Gantt embutido
  - **Viewport 3D** com colorização por estado
  - **Timeline** com slider, play/pause e velocidades
- Estados aplicados aos elementos 3D em cada data:
  - **Pendente** → oculto
  - **Em execução** → amarelo (`#F59E0B`)
  - **Concluído** → cor original visível
- Clique numa tarefa destaca em azul os produtos associados.

## Estrutura

```
src/
├─ main.ts                     # bootstrap + loop de simulação
├─ viewer/
│  ├─ setupWorld.ts            # cena, câmera, IfcLoader, FragmentsManager
│  └─ highlight.ts             # GUID → localId, highlight em lote
├─ schedule/
│  ├─ types.ts                 # tipos compartilhados
│  ├─ parseSchedule.ts         # leitura IFC nativo via web-ifc
│  └─ simulation.ts            # estado por data + estado por task
├─ ui/
│  ├─ taskTree.ts              # árvore + mini-Gantt
│  └─ timeline.ts              # slider + play/pause + velocidades
└─ styles.css
```

## Notas técnicas

- O WASM do `web-ifc` é servido em `/wasm/` (copiado de `node_modules/web-ifc/`).
- O parser do cronograma usa uma **instância dedicada** do `IfcAPI` (independente
  do `IfcLoader`), pois precisamos extrair entidades não-geométricas do IFC.
- A ligação entre o cronograma (lido pelo `web-ifc`) e o modelo (renderizado
  pelo Fragments) é feita via **GlobalId** (todas as `IfcProduct` têm um) e
  resolvida com `model.getLocalIdsByGuids()`.
- O `4D.ifc` deste workspace foi gerado pelo Bonsai (`IfcOpenShell v0.7.0`) e
  contém 1 `IfcWorkSchedule`, 94 `IfcTask`, 204 `IfcTaskTime` e 80
  `IfcRelSequence`.
