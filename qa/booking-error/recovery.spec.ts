import {expect,test,type Locator,type Page} from '@playwright/test';
const copy = {
  en: {title:'We could not display the booking page.',detail:'If you just submitted a booking, check your confirmation or contact the salon before booking again.',retry:'Reload booking form'},
  vi: {title:'Không thể hiển thị trang đặt lịch.',detail:'Nếu bạn vừa gửi yêu cầu đặt lịch, hãy kiểm tra xác nhận hoặc liên hệ tiệm trước khi đặt lại.',retry:'Tải lại biểu mẫu đặt lịch'},
};
function luminance(rgb:number[]) {
  return rgb.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[0.2126,0.7152,0.0722][i],0);
}
async function contrast(page:Page,card:Locator,text:Locator) {
  const png=await card.screenshot({scale:'css'});
  const bg=await page.evaluate(async source=>{
    const image=new Image();image.src=source;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);
    return [...ctx.getImageData(10,10,1,1).data].slice(0,3);
  },`data:image/png;base64,${png.toString('base64')}`);
  const fg=await text.evaluate(el=>getComputedStyle(el).color);
  const values=fg.match(/[\d.]+/g)!.map(Number),alpha=values[3]??1;
  const blended=bg.map((v,i)=>alpha*values[i]+(1-alpha)*v);
  const a=luminance(blended),b=luminance(bg);
  return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}
for(const width of [320,1024]) for(const theme of ['light','dark']) for(const language of ['en','vi'] as const) {
  test(`${width}px ${theme} ${language}: honest fallback, readable form and safe retry`,async({page,context},testInfo)=>{
    const blocked:string[]=[];
    await context.route('**/*',route=>{
      const req=route.request();
      if(new URL(req.url()).origin==='http://127.0.0.1:3123' && ['GET','HEAD'].includes(req.method()))return route.continue();
      blocked.push(req.method()+' '+new URL(req.url()).pathname);return route.abort();
    });
    await page.setViewportSize({width,height:844});
    await page.goto('/');
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption(language);
    await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);
    const counter=page.getByTestId('synthetic-confirmations');
    const alert=page.getByRole('main').getByRole('alert');
    await page.getByRole('button',{name:'Simulate confirmation then render failure',exact:true}).click();
    await expect(counter).toHaveText('Synthetic confirmations: 1');
    await expect(alert).toBeVisible();
    await expect.soft(alert.locator('p').nth(0)).toHaveText(copy[language].title);
    await expect.soft(alert.locator('p').nth(1)).toHaveText(copy[language].detail);
    await expect.soft(alert).not.toContainText(/not confirmed|chưa được xác nhận/i);
    const headingContrast=await contrast(page,alert,alert.locator('p').nth(0));
    const bodyContrast=await contrast(page,alert,alert.locator('p').nth(1));
    expect.soft(headingContrast).toBeGreaterThanOrEqual(4.5);
    expect.soft(bodyContrast).toBeGreaterThanOrEqual(4.5);
    const retry=alert.getByRole('button');
    await expect.soft(retry).toHaveText(copy[language].retry);
    expect.soft(await retry.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await testInfo.attach('fallback',{body:await alert.screenshot(),contentType:'image/png'});
    await testInfo.attach('contrast',{body:JSON.stringify({headingContrast,bodyContrast}),contentType:'application/json'});
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Booking flow ready',{exact:true})).toBeVisible();
    await expect(counter).toHaveText('Synthetic confirmations: 1');
    // Failure before any new confirmation also must not invent booking status.
    await page.getByRole('button',{name:'Simulate render failure',exact:true}).click();
    await expect.soft(alert.locator('p').nth(1)).toHaveText(copy[language].detail);
    await alert.getByRole('button').click();
    await expect(page.getByText('Booking flow ready',{exact:true})).toBeVisible();
    // An unresolved render error stays contained; retry never submits a booking.
    await page.getByRole('checkbox',{name:'Persistent render failure'}).check();
    await expect(alert).toBeVisible();await alert.getByRole('button').click();
    await expect(alert).toBeVisible();await expect(counter).toHaveText('Synthetic confirmations: 1');
    await page.getByRole('checkbox',{name:'Persistent render failure'}).uncheck();
    await alert.getByRole('button').click();
    await expect(page.getByText('Booking flow ready',{exact:true})).toBeVisible();
    expect(blocked).toEqual([]);
  });
}
