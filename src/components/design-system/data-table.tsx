export interface DataTableColumn {
  id: string;
  header: string;
}

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly DataTableColumn[];
  rows: readonly (readonly React.ReactNode[])[];
}) {
  return (
    <div className="v12-tablewrap">
      <table className="v12-table">
        <caption className="v12-sr">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={columns[cellIndex]?.id ?? cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
