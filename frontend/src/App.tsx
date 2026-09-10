import { Outlet } from 'react-router-dom';
import { DocumentImportProvider } from './pages/Documents/DocumentImportProvider';

export function App() {
  return <DocumentImportProvider><Outlet /></DocumentImportProvider>;
}
