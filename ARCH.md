# Diretriz de gravação

Decisão tomada pelo VTWIN, com aprovação do Ygor, em 2026-10-03.

O vtwin-viewer grava em duas frentes. O que pertence a uma não entra na outra.

## 1. IFC

O que é pertinente ao IFC fica no IFC.

Entram aqui as propriedades de disciplina dos elementos e tudo o que cabe na família do IFC segundo a prática da buildingSMART e do OpenBIM: hierarquia, relações, property sets, classificação, cronograma nativo e o restante que outro programa openBIM espera encontrar no STEP.

Esses dados mantêm-se no IFC e podem ser sobrescritos no IFC. A gravação desta frente prova-se com **Exportar IFC**: o ficheiro exportado é o mestre, e outro software openBIM abre-o sem um esquema paralelo nosso.

## 2. Fora do IFC

Tudo o que não for IFC grava-se na melhor arquitetura possível, externa ao IFC.

Pode viver dentro do pacote `.vtwin` (`Ctrl+S`). Não tem de viver dentro do IFC.

Inclui, entre outros:

- animação (keyframes)
- câmara
- markup
- tópicos BCF

**Exportar IFC** ignora esta frente. Não se escreve no STEP o que não pertence ao IFC só para o fazer persistir.
