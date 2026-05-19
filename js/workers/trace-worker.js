self.onmessage = function (ev) {
  try {
    var p = ev.data || {};
    var width = p.width | 0, height = p.height | 0;
    var rgba = new Uint8ClampedArray(p.rgba);
    var threshold = isFinite(p.threshold) ? p.threshold : 145;
    var minAreaPx = isFinite(p.minAreaPx) ? Math.max(0, p.minAreaPx) : 20;
    var mmPerPixel = isFinite(p.mmPerPixel) && p.mmPerPixel > 0 ? p.mmPerPixel : 0.2;
    var simplifyMm = isFinite(p.simplifyMm) ? Math.max(0.02, p.simplifyMm) : 0.08;
    var grid = new Uint8Array((width + 1) * (height + 1));
    for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) { var i = (y * width + x) * 4, a = rgba[i + 3] / 255; var lum = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) * a + (1 - a) * 255; if (lum < threshold) grid[y * (width + 1) + x] = 1; }
    function addEdge(edges, x1,y1,x2,y2){var k=x1+','+y1,a=edges.get(k);if(!a){a=[];edges.set(k,a);}a.push([x2,y2]);}
    var edges=new Map();
    for (var yy=0; yy<height; yy++) for (var xx=0; xx<width; xx++) if (grid[yy*(width+1)+xx]) { if (yy===0 || !grid[(yy-1)*(width+1)+xx]) addEdge(edges,xx,yy,xx+1,yy); if (xx===width-1 || !grid[yy*(width+1)+(xx+1)]) addEdge(edges,xx+1,yy,xx+1,yy+1); if (yy===height-1 || !grid[(yy+1)*(width+1)+xx]) addEdge(edges,xx+1,yy+1,xx,yy+1); if (xx===0 || !grid[yy*(width+1)+(xx-1)]) addEdge(edges,xx,yy+1,xx,yy); }
    function area(pts){var a=0;for(var i=0;i<pts.length-1;i++)a+=pts[i][0]*pts[i+1][1]-pts[i+1][0]*pts[i][1];return a/2;}
    function perp(p,a,b){var dx=b[0]-a[0],dy=b[1]-a[1];if(Math.abs(dx)+Math.abs(dy)<1e-9)return Math.hypot(p[0]-a[0],p[1]-a[1]);return Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/Math.hypot(dx,dy);} function simplify(points,tol){if(points.length<4)return points.slice();var pts=points.slice(0,-1),keep=new Uint8Array(pts.length);keep[0]=1;keep[pts.length-1]=1;var st=[[0,pts.length-1]];while(st.length){var s=st.pop(),a=s[0],b=s[1],mx=-1,idx=-1;for(var i=a+1;i<b;i++){var d=perp(pts[i],pts[a],pts[b]);if(d>mx){mx=d;idx=i;}}if(mx>tol&&idx>0){keep[idx]=1;st.push([a,idx],[idx,b]);}}var out=[];for(var j=0;j<pts.length;j++)if(keep[j])out.push(pts[j]);if(out.length>2)out.push(out[0]);return out;}
    var subpaths=[], nodesBefore=0, nodesAfter=0;
    while(edges.size){var key=edges.keys().next().value,sp=key.split(','),sx=+sp[0],sy=+sp[1],cx=sx,cy=sy,loop=[[cx,cy]],g=0;while(g++<200000){var k2=cx+','+cy,n=edges.get(k2);if(!n||!n.length)break;var nxt=n.pop();if(!n.length)edges.delete(k2);cx=nxt[0];cy=nxt[1];loop.push([cx,cy]);if(cx===sx&&cy===sy)break;}if(loop.length>3&&loop[loop.length-1][0]===sx&&loop[loop.length-1][1]===sy&&Math.abs(area(loop))>=minAreaPx){nodesBefore+=Math.max(0,loop.length-1);var simp=simplify(loop,simplifyMm/mmPerPixel); if(simp.length>=3){nodesAfter+=Math.max(0,simp.length-1);subpaths.push({points:simp.map(function(p){return [p[0]*mmPerPixel,p[1]*mmPerPixel];}),closed:true});}}}
    self.postMessage({ ok:true, geometry:{ width_mm: width*mmPerPixel, height_mm:height*mmPerPixel, hadUnits:true, subpaths:subpaths, trace:{widthPx:width,heightPx:height,threshold:threshold,worker:true,nodesBefore:nodesBefore,nodesAfter:nodesAfter} } });
  } catch (e) { self.postMessage({ ok:false, error:e && e.message ? e.message : String(e) }); }
};
