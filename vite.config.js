import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function uiHtmlHmrPlugin() {
	return {
		name: 'ui-html-hmr',
		apply: 'serve',
		transform(code, id) {
			if (!id.includes('/src/UI/Components/') || !id.endsWith('.js')) {
				return null;
			}

			// Find HTML raw import  
			const htmlImportRegex = /import\s+(\w+)\s+from\s+['"](\.[^'"]+\.html\?raw)['"]/g;
			const match = htmlImportRegex.exec(code);
			if (!match) return null;

			const htmlVarName = match[1];
			const htmlPath = match[2];

			// Find component name — support both UIComponent and ROComponent  
			const compRegex = /new\s+(?:UIComponent|ROComponent)\(\s*['"](\w+)['"]/;
			const compMatch = compRegex.exec(code);
			if (!compMatch) return null;

			const componentName = compMatch[1];

			// Inject HMR code  
			const hmrBlock = `  
            if (import.meta.hot) {  
                import.meta.hot.accept('${htmlPath}', (newModule) => {  
                    if (newModule && newModule.default) {  
                        const comp = UIManager.components['${componentName}'];  
                        if (comp && comp._shadow && comp.__active) {  
                            // Update the cached HTML  
                            comp._htmlText = newModule.default;  
                            // Re-render into shadow DOM  
                            const container = comp._shadow.querySelector('.ro-container');  
                            if (container && comp.render) {  
                                container.innerHTML = comp.render();  
                                // Re-process custom elements  
                                if (comp._processCustomElements) {  
                                    comp._processCustomElements();  
                                }  
                                // Re-bind events  
                                if (comp.onAppend) {  
                                    comp.onAppend();  
                                }  
                                console.log('[HMR] HTML updated: ${componentName}');  
                            }  
                        }  
                    }  
                });  
            }`;
			return { code: code + hmrBlock, map: null };
		}
	};
}

function uiCssHmrPlugin() {  
    return {  
        name: 'ui-css-hmr',  
        apply: 'serve',  
        transform(code, id) {  
            if (!id.includes('/src/UI/Components/') || !id.endsWith('.js')) {  
                return null;  
            }  
  
            const cssImportRegex = /import\s+(\w+)\s+from\s+['"](\.[^'"]+\.css\?raw)['"]/g;  
            const match = cssImportRegex.exec(code);  
            if (!match) return null;  
  
            const cssPath = match[2];  
  
            // Support both UIComponent and ROComponent  
            const compRegex = /new\s+(?:UIComponent|ROComponent)\(\s*['"](\w+)['"]/;  
            const compMatch = compRegex.exec(code);  
            if (!compMatch) return null;  
  
            const componentName = compMatch[1];  
  
            const hmrBlock = `  
            if (import.meta.hot) {  
                import.meta.hot.accept('${cssPath}', (newModule) => {  
                    if (newModule && newModule.default) {  
                        const comp = UIManager.components['${componentName}'];  
                        if (comp && comp._shadow) {  
                            // ROComponent: update <style> inside shadow DOM  
                            const style = comp._shadow.querySelector('style');  
                            if (style) {  
                                style.textContent = newModule.default;  
                                console.log('[HMR] CSS updated (shadow): ${componentName}');  
                                return;  
                            }  
                        }  
                        // Fallback: UIComponent global style  
                        UIComponent.reloadCSS('${componentName}', newModule.default);  
                    }  
                });  
            }`;  
            return { code: code + hmrBlock, map: null };  
        }  
    };  
}

export default defineConfig({
	plugins: [uiCssHmrPlugin(), uiHtmlHmrPlugin()],
	root: './',
	base: './',
	resolve: {
		alias: {
			'jquery': path.resolve(__dirname, 'src/Vendors/jquery-1.9.1.js'),
			App: path.resolve(__dirname, './src/App'),
			Audio: path.resolve(__dirname, './src/Audio'),
			Controls: path.resolve(__dirname, './src/Controls'),
			Core: path.resolve(__dirname, './src/Core'),
			DB: path.resolve(__dirname, './src/DB'),
			Engine: path.resolve(__dirname, './src/Engine'),
			Loaders: path.resolve(__dirname, './src/Loaders'),
			Network: path.resolve(__dirname, './src/Network'),
			Plugins: path.resolve(__dirname, './src/Plugins'),
			Preferences: path.resolve(__dirname, './src/Preferences'),
			Renderer: path.resolve(__dirname, './src/Renderer'),
			UI: path.resolve(__dirname, './src/UI'),
			Utils: path.resolve(__dirname, './src/Utils'),
			Vendors: path.resolve(__dirname, './src/Vendors')
		}
	},
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.test.js'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.js'],
			exclude: ['src/Vendors/**']
		}
	},
	build: {
		outDir: 'dist/Web',
		rollupOptions: {
			input: {
				main: path.resolve(__dirname, 'index.html')
			}
		}
	},
	server: {
		port: 3000,
		open: true
	}
});
